-- 117. La auditoría visible (listAudit, también la actividad reciente del inicio) evalúa los permisos de
-- quien mira una sola vez por consulta y no en cada evento: con muchos eventos (una empresa con un año
-- de trabajo, más con la empresa que crece de la Fase 9), quien no tiene audit.read esperaba segundos.
-- El resultado es el mismo que antes.

create or replace function private.audit_items(p_company uuid, p_limit int)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]')
    from (
      select e.*
        from public.audit_events e
        left join public.documents d on d.id = e.document_id
       where e.company_id = p_company
         and ((select private.has_permission(p_company, 'audit.read'))
              or e.actor_user_id = (select auth.uid())
              or d.doc_type = any ((select private.readable_doc_types(p_company))::text[]))
       order by e.id desc
       limit p_limit
    ) e
$$;
