-- ═══════════════════════════════════════════════════════════
-- 0049 — Fazer as permissões VALEREM
--
-- A 0048 criou a coluna e a tela de permissões, mas nada as consultava:
-- has_event_access só olhava o papel. Na prática a matriz era decorativa —
-- e isso é pior do que não existir, porque a produtora marcava
-- "finance:view" para alguém, via a tela confirmar, e acreditava ter
-- concedido um acesso que o servidor ignorava.
--
-- A permissão é um caminho ALTERNATIVO ao papel, nunca uma restrição: quem
-- já entra pelo papel continua entrando. Permissão só ACRESCENTA. O
-- contrário — permissão que tira acesso de quem tem o papel — transformaria
-- uma lista vazia (o padrão de todo mundo hoje) em bloqueio geral no
-- primeiro deploy.
--
-- SUBSTITUI a função de 3 argumentos em vez de criar uma sobrecarga. Com as
-- duas convivendo, todo chamador antigo continuaria caindo na versão que
-- ignora permissões, e a correção não teria efeito nenhum. O novo argumento
-- tem default, então as chamadas existentes seguem compilando.
-- ═══════════════════════════════════════════════════════════

drop function if exists public.has_event_access(uuid, uuid, text[]);

create or replace function public.has_event_access(
  p_event uuid,
  p_user  uuid,
  p_roles text[] default null,
  p_perm  text default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    -- Dono da organização: sempre passa.
    select 1
      from public.events e
      join public.organizations o on o.id = e.organization_id
     where e.id = p_event and o.owner_id = p_user
  )
  or exists (
    select 1
      from public.event_staff s
     where s.event_id = p_event
       and s.user_id = p_user
       and (
         -- Caminho 1: o papel basta.
         (p_roles is null or s.role::text = any(p_roles))
         -- Caminho 2: não tem o papel, mas recebeu a permissão específica.
         or (p_perm is not null and p_perm = any(s.permissoes))
       )
  );
$$;

revoke all on function public.has_event_access(uuid, uuid, text[], text) from public, anon;
grant execute on function public.has_event_access(uuid, uuid, text[], text) to authenticated, service_role;

comment on function public.has_event_access(uuid, uuid, text[], text) is
  'Dono OU papel OU permissão específica. Permissão só acrescenta acesso — nunca tira de quem já tem o papel.';
