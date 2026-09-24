create table if not exists public.translation_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  requests integer not null default 0 check (requests >= 0),
  characters bigint not null default 0 check (characters >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create table if not exists public.translation_global_usage (
  usage_date date primary key,
  requests integer not null default 0 check (requests >= 0),
  characters bigint not null default 0 check (characters >= 0),
  updated_at timestamptz not null default now()
);

alter table public.translation_usage enable row level security;
alter table public.translation_global_usage enable row level security;
revoke all on public.translation_usage from anon, authenticated;
revoke all on public.translation_global_usage from anon, authenticated;

create or replace function public.consume_translation_quota(p_characters integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_user_characters bigint;
  v_global_characters bigint;
begin
  if v_user is null then
    return jsonb_build_object('allowed', false, 'code', 'AUTH_REQUIRED');
  end if;
  if p_characters is null or p_characters < 1 or p_characters > 6000 then
    return jsonb_build_object('allowed', false, 'code', 'INVALID_SIZE');
  end if;

  begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lingoleaf:' || v_day::text, 0));

    insert into public.translation_global_usage as g (usage_date, requests, characters)
    values (v_day, 1, p_characters)
    on conflict (usage_date) do update
      set requests = g.requests + 1,
          characters = g.characters + excluded.characters,
          updated_at = now()
      where g.requests < 2000
        and g.characters + excluded.characters <= 200000
    returning characters into v_global_characters;
    if not found then
      raise exception 'SERVICE_DAILY_LIMIT';
    end if;

    insert into public.translation_usage as u (user_id, usage_date, requests, characters)
    values (v_user, v_day, 1, p_characters)
    on conflict (user_id, usage_date) do update
      set requests = u.requests + 1,
          characters = u.characters + excluded.characters,
          updated_at = now()
      where u.requests < 100
        and u.characters + excluded.characters <= 20000
    returning characters into v_user_characters;
    if not found then
      raise exception 'USER_DAILY_LIMIT';
    end if;
  exception
    when others then
      if sqlerrm = 'SERVICE_DAILY_LIMIT' then
        return jsonb_build_object('allowed', false, 'code', 'SERVICE_DAILY_LIMIT');
      elsif sqlerrm = 'USER_DAILY_LIMIT' then
        return jsonb_build_object('allowed', false, 'code', 'USER_DAILY_LIMIT');
      end if;
      raise;
  end;

  return jsonb_build_object(
    'allowed', true,
    'user_characters', v_user_characters,
    'user_remaining', greatest(0, 20000 - v_user_characters),
    'service_characters', v_global_characters
  );
end;
$$;

revoke all on function public.consume_translation_quota(integer) from public, anon;
grant execute on function public.consume_translation_quota(integer) to authenticated;
