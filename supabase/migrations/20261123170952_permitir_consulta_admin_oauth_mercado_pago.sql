-- OAuth rechecks the organizer's admin flag after the provider redirect.
grant select (id, eh_admin) on table public.perfis to service_role;
