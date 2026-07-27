import db from '@nangohq/database';
import { accountService, userService } from '@nangohq/shared';
import { getLogger, requireEmptyBody, requireEmptyQuery, zodErrorToHTTP } from '@nangohq/utils';

import { sendAccountInvitationRequestEmail } from '../../../../helpers/email.js';
import { asyncWrapper } from '../../../../utils/asyncWrapper.js';
import { clearPendingAccountDiscovery, getPendingAccountDiscovery } from './accountDiscoverySession.js';

import type { PostOnboardingRequestInvite } from '@nangohq/types';

const logger = getLogger('Server.PostOnboardingRequestInvite');

export const postOnboardingRequestInvite = asyncWrapper<PostOnboardingRequestInvite>(async (req, res) => {
    const emptyQuery = requireEmptyQuery(req, { withEnv: false });
    if (emptyQuery) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(emptyQuery.error) } });
        return;
    }

    const emptyBody = requireEmptyBody(req);
    if (emptyBody) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(emptyBody.error) } });
        return;
    }

    const { user } = res.locals;
    const discovery = await getPendingAccountDiscovery(req, user.id);
    if (!discovery?.recommendation || !user.email_verified) {
        logger.error("Pending account discovery marker not found in session or email not verified, can't send invite requests.", {
            emailVerified: user.email_verified
        });
        res.status(404).send({ error: { code: 'not_found' } });
        return;
    }

    const account = await accountService.getAccountById(db.knex, discovery.recommendation.accountId);
    if (!account) {
        logger.error('Recommended account not found.', { accountId: discovery.recommendation.accountId });
        res.status(404).send({ error: { code: 'not_found' } });
        return;
    }

    const administrators = await userService.getActiveAdministratorsByAccountId(account.id);
    if (administrators.length === 0) {
        logger.error('No administrators found for recommended account.', { accountId: discovery.recommendation.accountId });
        res.status(404).send({ error: { code: 'not_found' } });
        return;
    }

    const requestedAt = await userService.markAccountInvitationRequestSent(user.id);

    if (requestedAt) {
        const emailResults = await Promise.allSettled(
            administrators.map((administrator) => sendAccountInvitationRequestEmail({ email: administrator.email, account, requester: user }))
        );

        const failedEmailCount = emailResults.filter((result) => result.status === 'rejected').length;
        if (failedEmailCount === emailResults.length) {
            const unmarked = await userService.unmarkAccountInvitationRequest(user.id, requestedAt);
            logger.error('Failed to send all account invitation request emails', {
                failedEmailCount,
                requesterId: user.id,
                accountId: account.id,
                unmarked
            });
            res.status(503).send({ error: { code: 'email_delivery_failed' } });
            return;
        }

        if (failedEmailCount > 0) {
            logger.error('Failed to send account invitation request emails', {
                totalEmailsCount: emailResults.length,
                failedEmailCount,
                requesterId: user.id,
                accountId: account.id
            });
        }

        await clearPendingAccountDiscovery(req).catch((err) =>
            logger.warning('Failed to clear account discovery onboarding session', { error: err, userId: user.id })
        );
    }

    res.status(200).send({ data: { success: true } });
});
