-- Fix trigger handle_new_user to handle missing metadata
-- Generates username from email if not provided in metadata

CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meta jsonb := coalesce(new.raw_app_meta_data, new.raw_user_meta_data, '{}');
  v_username text := lower(trim(v_meta ->> 'username'));
BEGIN
  IF v_username IS NULL OR v_username = '' THEN
    v_username := lower(split_part(new.email, '@', 1));
  END IF;
  INSERT INTO public.profiles (id, username, first_name, last_name, app_role, must_change_password)
  VALUES (
    new.id,
    v_username,
    trim(coalesce(v_meta ->> 'first_name', '')),
    trim(coalesce(v_meta ->> 'last_name', '')),
    coalesce(v_meta ->> 'app_role', 'ESTUDIANTE'),
    coalesce((v_meta ->> 'must_change_password')::boolean, true)
  );
  RETURN new;
END;
$$;