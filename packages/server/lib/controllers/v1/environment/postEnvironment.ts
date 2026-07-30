import * as z from 'zod';

import db from '@nangohq/database';
import { environmentService, externalWebhookService, getPlan } from '@nangohq/shared';
import { flagHasPlan, requireEmptyQuery, zodErrorToHTTP } from '@nangohq/utils';

import { envSchema } from '../../../helpers/validation.js';
import { asyncWrapper } from '../../../utils/asyncWrapper.js';
import { sendCreateEnvironmentError } from '../../environment/sendCreateEnvironmentError.js';

import type { PostEnvironment } from '@nangohq/types';

const validationBody = z
    .object({
        name: envSchema
    })
    .strict();

export const postEnvironment = asyncWrapper<PostEnvironment>(async (req, res) => {
    const emptyQuery = requireEmptyQuery(req);
    if (emptyQuery) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(emptyQuery.error) } });
        return;
    }

    const valBody = validationBody.safeParse(req.body);
    if (!valBody.success) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(valBody.error) } });
        return;
    }

    const body: PostEnvironment['Body'] = valBody.data;

    const accountId = res.locals.account.id;
    let plan;

    if (flagHasPlan) {
        const planRes = await getPlan(db.knex, { accountId });
        if (planRes.isErr()) {
            res.status(500).send({ error: { code: 'server_error', message: 'Unable to get plan' } });
            return;
        }

        plan = planRes.value;
    }

    const created = await environmentService.createEnvironment(db.knex, { accountId, name: body.name, ...(plan && { plan }) });
    if (created.isErr()) {
        sendCreateEnvironmentError(res, created.error);
        return;
    }

    const environment = created.value;

    await externalWebhookService.update(db.knex, {
        environment_id: environment.id,
        data: {
            on_auth_creation: true,
            on_auth_refresh_error: true,
            on_sync_completion_always: true,
            on_sync_error: true
        }
    });

    res.status(200).send({ data: { id: environment.id, name: environment.name } });
});
