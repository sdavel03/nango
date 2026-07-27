exports.up = async function (knex) {
    await knex.schema.alterTable('_nango_users', (table) => {
        table.timestamp('account_invitation_requested_at', { useTz: true }).nullable();
    });
};

exports.down = function () {};
