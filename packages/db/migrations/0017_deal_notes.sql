-- Free-text notes on a deal, for context that doesn't fit a stage or an
-- amount — what the customer actually said, why the deal is stuck, what to
-- follow up on. Not sealed like a contact's personal fields: a deal note is
-- written by the team, about the sale, not personal data about the customer.
alter table deals add column if not exists notes text;
