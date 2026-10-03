-- Datos iniciales para desarrollo local: `npx supabase db reset` los aplica
-- después de las migraciones. En una instancia real se usan los datos de la
-- escuela (docs/INSTANCIAS.md §6, paso 4) y la misma plantilla.

insert into public.school_settings (official_name, short_name, city, province)
values ('Escuela de demostración', 'Demo', 'Eldorado', 'Misiones')
on conflict (id) do nothing;

-- Empresa plantilla Forestal del Norte SRL (datos ficticios), idéntica a la demo local.
select private.seed_demo_company();
