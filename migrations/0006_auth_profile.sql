-- ═══════════════════════════════════════════════════════════════
-- PulsePass · Migration 0006 — Cadastro: copiar CPF/telefone
-- handle_new_user passa a popular cpf e phone a partir do metadata
-- enviado no signUp (options.data). Aplicar após 0005.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, full_name, email, cpf, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email,
    nullif(new.raw_user_meta_data->>'cpf', ''),
    nullif(new.raw_user_meta_data->>'phone', '')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
        cpf       = coalesce(public.profiles.cpf, excluded.cpf),
        phone     = coalesce(public.profiles.phone, excluded.phone);
  return new;
end;
$$ language plpgsql security definer;
