-- Add logo_path support to school_settings_update RPC
-- The logo_path column already exists in the table, we just need to handle it in the RPC.

CREATE OR REPLACE FUNCTION public.school_settings_update(p_settings jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor private.actor := private.require_school_admin();
  v_official text := trim(coalesce(p_settings ->> 'official_name', ''));
  v_short text := trim(coalesce(p_settings ->> 'short_name', ''));
  v_email text := trim(coalesce(p_settings ->> 'contact_email', ''));
  v_logo_path text := trim(coalesce(p_settings ->> 'logo_path', ''));
  v_minutes numeric := (p_settings ->> 'session_timeout_minutes')::numeric;
  v_before jsonb;
  v_after jsonb;
  v_keys text[] := array['official_name', 'short_name', 'city', 'province', 'contact_email', 'session_timeout_minutes', 'logo_path'];
BEGIN
  IF length(v_official) < 3 THEN
    PERFORM private.raise_business_error('DATO_INVALIDO', 'Ingresá el nombre oficial de la escuela.');
  END IF;
  IF length(v_short) NOT BETWEEN 2 AND 30 THEN
    PERFORM private.raise_business_error('DATO_INVALIDO', 'El nombre corto debe tener entre 2 y 30 caracteres (por ejemplo, "ENS N.º 9").');
  END IF;
  IF v_email <> '' AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    PERFORM private.raise_business_error('DATO_INVALIDO', 'El email de contacto no es válido.');
  END IF;
  IF v_minutes IS NULL OR v_minutes <> trunc(v_minutes) OR (v_minutes <> 0 AND v_minutes NOT BETWEEN 5 AND 240) THEN
    PERFORM private.raise_business_error('DATO_INVALIDO', 'El cierre por inactividad va de 5 a 240 minutos (o 0 para no cerrar la sesión).');
  END IF;
  SELECT to_jsonb(s) INTO v_before FROM public.school_settings s WHERE s.id = 1 FOR UPDATE;
  UPDATE public.school_settings
     SET official_name = v_official,
         short_name = v_short,
         city = trim(coalesce(p_settings ->> 'city', '')),
         province = trim(coalesce(p_settings ->> 'province', '')),
         contact_email = v_email,
         session_timeout_minutes = v_minutes::int,
         logo_path = NULLIF(v_logo_path, ''),
         updated_at = now(),
         updated_by = (SELECT auth.uid())
   WHERE id = 1
   RETURNING to_jsonb(school_settings) INTO v_after;
  IF private.diff(v_before, v_after, v_keys) <> '{}'::jsonb THEN
    PERFORM private.log_audit(null, v_actor, 'SETTINGS', 'school_settings', null, v_official,
      'Cambió los datos de la escuela', null, null, null, private.diff(v_before, v_after, v_keys));
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.school_settings_update(jsonb) TO authenticated;