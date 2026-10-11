-- Create storage bucket for school logos (only if storage extension is available)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('school-logos', 'school-logos', true, 5242880, ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
    ON CONFLICT (id) DO NOTHING;

    -- Policy: anyone can view logos (public bucket)
    CREATE POLICY "Public read access for school logos" ON storage.objects
      FOR SELECT USING (bucket_id = 'school-logos');

    -- Policy: only school admins can upload/update/delete logos
    CREATE POLICY "School admins can upload logos" ON storage.objects
      FOR INSERT WITH CHECK (
        bucket_id = 'school-logos' AND
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.app_role IN ('SUPERADMIN', 'ADMIN')
        )
      );

    CREATE POLICY "School admins can update logos" ON storage.objects
      FOR UPDATE USING (
        bucket_id = 'school-logos' AND
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.app_role IN ('SUPERADMIN', 'ADMIN')
        )
      );

    CREATE POLICY "School admins can delete logos" ON storage.objects
      FOR DELETE USING (
        bucket_id = 'school-logos' AND
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid() AND p.app_role IN ('SUPERADMIN', 'ADMIN')
        )
      );
  END IF;
END $$;