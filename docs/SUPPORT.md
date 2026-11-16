# Help and support

M9 slice 4. People in an organisation ask the Talk2Tax team for help with tickets. Support staff answer from Platform admin → Support. If support needs to see the books, the organisation can grant read-only access for a limited time. Every page support opens under that access is logged for the organisation to see.

## For an organisation (Help and support)

Everyone in an organisation can open a ticket, including staff who only claim expenses. Opening a ticket also works while the books are read-only, after a lapsed plan or a suspension.

A ticket has:
- a subject;
- a topic: billing, something not working, accounting, tax, sign-in and team, or something else;
- an urgency;
- the first message.

Who sees which tickets:
- owners and admins see every ticket from the organisation;
- everyone else sees the tickets they opened.

The ticket page shows the conversation, whose turn it is, and the promised response times. From there you can:
- reply;
- close the ticket;
- reopen a resolved ticket, by replying or with **Not fixed: reopen**.

A closed ticket is final. If there is more to do, open a new one.

When support replies, the person who opened the ticket gets an email. It goes through the organisation's email set-up (Settings → Integrations, or the server's fallback). The reply shows in Talk2Tax either way.

## Response times

The times count every hour of the day, not just business hours. They are counted from when the ticket was opened.

| Urgency | First answer | Resolution |
|---|---|---|
| Urgent | 1 hour | 8 hours |
| High | 4 hours | 24 hours |
| Normal | 24 hours | 72 hours |
| Low | 72 hours | 7 days |

- **First answer**: support's first reply that the customer can see. Internal notes do not count.
- **Resolution**: the first time the ticket is resolved or closed. Reopening the ticket does not reset the clock.

Each target shows one of these states:
- on track;
- due soon, in the last quarter of the window;
- overdue;
- met;
- missed.

The rules are in `packages/accounting-engine/src/support.ts`.

## States

| State | Meaning | How it gets there |
|---|---|---|
| Open | Support's turn | A new ticket, or a reply from the customer (this also reopens a resolved ticket) |
| Pending | Waiting on the customer | A reply from support |
| Resolved | Support thinks it is done | Support marks it resolved, possibly with a reply |
| Closed | Final | The customer or support closes it |

Support's internal notes do not change the state.

## For support (Platform admin → Support)

Both platform roles, SUPPORT and SUPER_ADMIN, have `platform.support`.

**The queue.** Tickets are ordered by:
1. whose turn it is;
2. the nearest promised time;
3. age.

You can filter by state and by assignee (me or nobody), and search by subject or ticket number (`T-000123`). The counts at the top show tickets waiting on support, waiting on the customer, past a promised time, and resolved but not closed.

**A ticket.** Support sees the whole conversation, including internal notes. Internal notes are marked and never shown to the customer. From a ticket, support can:
- reply, and resolve in the same step;
- add an internal note;
- assign the ticket to someone with a support role;
- change the urgency;
- resolve, reopen or close the ticket.

Whoever answers first takes an unassigned ticket.

**The boundary.** Support sees an organisation's name, country and plan, and the messages. It does not see the books. If the organisation has granted support access, the ticket shows **Open the books, read-only**.

Every message is permanent: a database trigger prevents changes and deletions. Every change of state, assignee or urgency is added to the organisation's audit chain.

## Support access to the books (ADMIN-022)

Only an owner or admin can give access. This is done under Help and support, or from a ticket.

A grant:
- lasts between 1 and 72 hours, chosen in the form;
- needs a reason;
- can be tied to a ticket. The grant is then also posted on the ticket.

Only one grant can be active at a time. It ends on its own when the time runs out, and an owner or admin can end it early at any time.

While a grant is active, a person with a support role who is not a member of the organisation can open it:
- **Viewer rights only.** Support has the VIEWER role's permissions, so payroll, the audit trail and management settings stay hidden.
- **Reads only.** GET and HEAD requests only. Any change is refused with 403 `SUPPORT_READ_ONLY`. This includes opening tickets as the organisation.
- **Every request is logged.** Each request support makes, with the path and query, is written to `support_access_views`. The organisation sees this list as **What support looked at**, with the name of the person and the time.
- **The shell shows it.** A banner tells support whose books they are reading, until when, and that the organisation sees every page.

The check is in the auth guard (`apps/api/src/auth/guards.ts`, `viaSupport`). It looks up the grant with system access, then narrows the request to the organisation as for a member.

Grants, revocations and ticket changes go into the organisation's audit chain. Grants cannot be deleted, and can only be revoked, once (database trigger). The access log is append-only.

Without a grant, a platform role still gives no access to an organisation's routes: they answer 404, as before.

## API

See [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) › Support.

## Tests

- Engine: `test/support.test.ts`, 8 tests. They cover targets, the due-soon and overdue states, transitions, grant lengths, ticket numbers and queue order.
- API: `test/support.e2e.test.ts`, 7 tests. They cover:
  - who sees which tickets;
  - internal notes hidden from the customer;
  - the reply email, through a local SMTP stand-in;
  - assignment to support staff only;
  - the states;
  - grant limits;
  - viewer-only, read-only access;
  - one organisation's grant not opening another;
  - the access log;
  - revocation;
  - immutability;
  - closed tickets being final.
- Browser: `e2e/support-flow.test.mjs`. In it:
  1. an owner opens a ticket;
  2. an agent adds a note and replies;
  3. the owner grants access from the ticket;
  4. the agent reads the accounts and a write is refused;
  5. the owner sees what was looked at and ends the access;
  6. the agent is shut out again.

## Not yet

- Attachments on tickets.
- Email in. Customers reply in Talk2Tax, not by answering the email.
- Business-hours targets and holiday calendars.
- Automatic closing of resolved tickets.
- Notifications to support staff. They work from the queue.
- Satisfaction ratings.
