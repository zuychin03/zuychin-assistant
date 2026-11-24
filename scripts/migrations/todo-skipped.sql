-- Skipped tasks: the Notes panel can skip a task as well as tick it off, so a task the owner dropped is not read as done.
-- Apply manually; safe to re-run, in one transaction or statement by statement. Widens the todos status check only;
-- tasks already ticked off stay 'done'.
alter table public.todos drop constraint if exists todos_status_check;
alter table public.todos add constraint todos_status_check
  check (status in ('pending', 'in_progress', 'done', 'skipped'));
