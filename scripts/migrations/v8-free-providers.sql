-- V8 free providers for the stored catalogue: the LlamaParse seed row (docs/V8_FREE_PROVIDERS_PLAN.md). Apply manually
-- after v8-media.sql; safe to re-run. Additive: one seed row, unapproved, so nothing uses it before Test and Approve.
-- Cloudflare Workers AI rows come from its model search and need no seed.
begin;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_catalogue_kind_check' and pg_get_constraintdef(oid) like '%''parse''%'
  ) then
    raise exception 'Apply v8-media.sql before v8-free-providers.sql.';
  end if;
end $$;

-- LlamaParse has no model list; the tier is the model. Cloudflare and LlamaParse do not train on inputs.
insert into public.model_catalogue (
  provider_id, model_id, kind, label, short_name, description, developer, free, metered, may_train, inputs, traits,
  origin, probe_status
) values (
  'llamaparse', 'cost_effective', 'parse', 'LlamaParse Cost-effective (free)', 'llamaparse-cost-effective',
  'Reads a PDF, image or office file into Markdown with tables, through upload and poll. 3 credits a page.', 'LlamaIndex',
  true, false, false, array['PDF', 'Image'], '{}'::jsonb, 'seed', 'untested'
)
on conflict (provider_id, model_id) do nothing;

notify pgrst, 'reload schema';
commit;
