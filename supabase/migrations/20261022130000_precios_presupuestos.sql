-- 39. Fase 4d (docs/FASE_4_VENTAS_Y_CLIENTES.md §6): listas de precios (la
-- del cliente se propone en sus pedidos y presupuestos) y presupuestos que, al
-- aceptarse, generan el pedido de venta. Traducción de las secciones "Listas de
-- precios" y "Presupuestos" de src/lib/mock/engine.ts y de sus lecturas en
-- queries.ts, con los mismos mensajes y la misma forma de datos.
--
-- El tipo de documento, sus estados, transiciones, tareas y permisos están en
-- la migración de catálogos siguiente.

-- ------------------------------------------------------------------ Tablas

-- Lista de precios de una empresa: el precio sin IVA de cada producto que se vende.
create table public.price_lists (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  name text not null check (length(name) between 2 and 60),
  description text not null default '' check (length(description) <= 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  unique (company_id, code),
  unique (company_id, id)
);

create table public.price_list_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  price_list_id uuid not null,
  product_id uuid not null,
  unit_price numeric(14, 2) not null check (unit_price > 0),
  unique (price_list_id, product_id),
  unique (company_id, id),
  foreign key (company_id, price_list_id) references public.price_lists (company_id, id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);
create index price_list_items_product_idx on public.price_list_items (product_id);

-- La lista que se le propone al cliente; sin lista, el precio de venta de cada producto.
alter table public.customers add column price_list_id uuid;
alter table public.customers add constraint customers_price_list_fk
  foreign key (company_id, price_list_id) references public.price_lists (company_id, id);

-- Presupuesto: 1 a 1 con documents (tipo SALES_QUOTE).
create table public.sales_quotes (
  document_id uuid primary key,
  doc_type text not null default 'SALES_QUOTE' check (doc_type = 'SALES_QUOTE'),
  company_id uuid not null,
  valid_until date not null,              -- hasta cuándo vale la oferta
  warehouse_id uuid not null,             -- desde dónde se entregaría: pasa al pedido
  payment_terms_days int not null check (payment_terms_days between 0 and 365),
  customer_reference text not null default '',
  unique (company_id, document_id),
  foreign key (company_id, document_id, doc_type) references public.documents (company_id, id, doc_type) on delete cascade,
  foreign key (company_id, warehouse_id) references public.warehouses (company_id, id)
);

create table public.sales_quote_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  list_price numeric(14, 4) not null,     -- el de la lista del cliente al cotizar: la bonificación se mide contra él
  unit_price numeric(14, 4) not null check (unit_price > 0),
  vat_rate numeric(5, 2) not null,
  line_subtotal numeric(14, 2) not null,
  line_tax numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  unique (document_id, line_no),
  unique (company_id, id),
  foreign key (company_id, document_id) references public.sales_quotes (company_id, document_id) on delete cascade,
  foreign key (company_id, product_id) references public.products (company_id, id)
);

create trigger price_lists_audit before insert or update on public.price_lists
  for each row execute function private.set_audit_fields();

do $$
declare
  t text;
begin
  foreach t in array array['price_lists', 'price_list_items', 'sales_quotes', 'sales_quote_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.prevent_company_change()',
      t || '_same_company', t
    );
  end loop;
end;
$$;

create policy price_lists_select on public.price_lists for select to authenticated
  using (company_id in (select private.companies_with_permission('price_list.read')));
create policy price_list_items_select on public.price_list_items for select to authenticated
  using (company_id in (select private.companies_with_permission('price_list.read')));
create policy sales_quotes_select on public.sales_quotes for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_quote.read')));
create policy sales_quote_lines_select on public.sales_quote_lines for select to authenticated
  using (company_id in (select private.companies_with_permission('sales_quote.read')));

-- ------------------------------------------------------------------ Listas de precios: auxiliares

-- "MAY Mayorista" (priceListLabel).
create function private.price_list_label(p_list public.price_lists)
returns text
language sql
immutable
set search_path = ''
as $$ select p_list.code || ' ' || p_list.name $$;

-- "+8 %", "-10 %" o "2,5 %": un porcentaje dentro de una frase (percentLabel).
create function private.percent_label(p_percent numeric)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p_percent > 0 then '+' else '' end || private.format_qty(p_percent) || ' %' $$;

-- El precio de lista de un producto para un cliente: el de su lista (si está activa y lo tiene) o el de venta (listPriceFor).
create function private.list_price_for(p_customer uuid, p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select i.unit_price
       from public.customers c
       join public.price_lists l on l.id = c.price_list_id and l.is_active
       join public.price_list_items i on i.price_list_id = l.id and i.product_id = p_product
      where c.id = p_customer),
    (select coalesce(p.sale_price, 0) from public.products p where p.id = p_product))
$$;

-- Una lista de precios de la empresa (getPriceList).
create function private.price_list_for(p_company uuid, p_list text)
returns public.price_lists
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list public.price_lists;
begin
  select * into v_list from public.price_lists l where l.company_id = p_company and l.id::text = p_list;
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'La lista de precios no existe.');
  end if;
  return v_list;
end;
$$;

-- Porcentaje de un ajuste: con hasta 2 decimales, mayor que −90 y de hasta 1000 (validPercent).
create function private.valid_percent(p_percent numeric)
returns numeric
language plpgsql
set search_path = ''
as $$
begin
  if p_percent is null or round(p_percent, 2) <> p_percent or p_percent <= -90 or p_percent > 1000 then
    perform private.raise_business_error('DATO_INVALIDO',
      'El porcentaje debe tener hasta 2 decimales, ser mayor que −90 y de hasta 1000.');
  end if;
  return p_percent;
end;
$$;

-- Un precio ajustado por un porcentaje, con 2 decimales (adjustedPrice).
create function private.adjusted_price(p_price numeric, p_percent numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$ select round(p_price * (100 + p_percent) / 100, 2) $$;

-- Un producto como lo muestran las listas de precios (PriceListProduct).
create function private.price_list_product(p_product public.products)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('id', p_product.id, 'code', p_product.code, 'name', p_product.name,
                            'uom_code', p_product.uom_code, 'product_type', p_product.product_type,
                            'sale_price', p_product.sale_price, 'is_active', p_product.is_active)
$$;

-- ------------------------------------------------------------------ Listas de precios: comandos

-- p_input: {code, name, description, copy_from: '' | 'SALE_PRICE' | id de otra lista, percent} (cmdCreatePriceList)
create function public.pl_create(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'price_list.create');
  v_code text := upper(trim(coalesce(p_input ->> 'code', '')));
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_description text := trim(coalesce(p_input ->> 'description', ''));
  v_copy text := coalesce(p_input ->> 'copy_from', '');
  v_percent numeric;
  v_from public.price_lists;
  v_items jsonb := '[]';
  v_zero text;
  v_list public.price_lists;
  v_origin text;
begin
  if v_code !~ '^[A-Z0-9-]{1,12}$' then
    perform private.raise_business_error('DATO_INVALIDO', 'El código de la lista tiene de 1 a 12 letras, números o guiones.');
  end if;
  if exists (select 1 from public.price_lists l where l.company_id = p_company_id and l.code = v_code) then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe una lista de precios con el código %s.', v_code));
  end if;
  if length(v_name) < 2 or length(v_name) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre de la lista tiene de 2 a 60 caracteres.');
  end if;
  if length(v_description) > 200 then
    perform private.raise_business_error('DATO_INVALIDO', 'La descripción tiene hasta 200 caracteres.');
  end if;
  v_percent := private.valid_percent((p_input ->> 'percent')::numeric);
  if v_copy = 'SALE_PRICE' then
    select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'code', p.code,
                                                 'price', private.adjusted_price(p.sale_price, v_percent))
                              order by p.code collate "C"), '[]')
      into v_items
      from public.products p
     where p.company_id = p_company_id and p.is_active
       and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO') and coalesce(p.sale_price, 0) > 0;
  elsif v_copy <> '' then
    v_from := private.price_list_for(p_company_id, v_copy);
    select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'code', p.code,
                                                 'price', private.adjusted_price(i.unit_price, v_percent))
                              order by p.code collate "C"), '[]')
      into v_items
      from public.price_list_items i join public.products p on p.id = i.product_id
     where i.price_list_id = v_from.id;
  end if;
  select x.item ->> 'code' into v_zero
    from jsonb_array_elements(v_items) with ordinality as x (item, ord)
   where (x.item ->> 'price')::numeric <= 0
   order by x.ord
   limit 1;
  if v_zero is not null then
    perform private.raise_business_error('DATO_INVALIDO', format('El precio de %s quedaría en cero: usá un porcentaje menor.', v_zero));
  end if;
  insert into public.price_lists (company_id, code, name, description)
  values (p_company_id, v_code, v_name, v_description)
  returning * into v_list;
  insert into public.price_list_items (company_id, price_list_id, product_id, unit_price)
  select p_company_id, v_list.id, (x ->> 'product_id')::uuid, (x ->> 'price')::numeric from jsonb_array_elements(v_items) as x;
  v_origin := case
    when v_copy = 'SALE_PRICE' then format(' con %s productos a su precio de venta', jsonb_array_length(v_items))
    when v_from.id is not null then
      format(' con %s productos de la lista %s', jsonb_array_length(v_items), private.price_list_label(v_from))
    else ''
  end;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'price_list', v_list.id, private.price_list_label(v_list),
    format('Creó la lista de precios %s%s%s', private.price_list_label(v_list), v_origin,
           case when v_origin <> '' and v_percent <> 0 then ' ' || private.percent_label(v_percent) else '' end));
  return jsonb_build_object('id', v_list.id, 'code', v_list.code);
end;
$$;

-- p_input: {name, description} (cmdUpdatePriceList)
create function public.pl_update(p_company_id uuid, p_price_list_id uuid, p_input jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'price_list.update');
  v_list public.price_lists := private.price_list_for(p_company_id, p_price_list_id::text);
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_description text := trim(coalesce(p_input ->> 'description', ''));
  v_after public.price_lists;
  v_changes jsonb;
begin
  if length(v_name) < 2 or length(v_name) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'El nombre de la lista tiene de 2 a 60 caracteres.');
  end if;
  if length(v_description) > 200 then
    perform private.raise_business_error('DATO_INVALIDO', 'La descripción tiene hasta 200 caracteres.');
  end if;
  update public.price_lists set name = v_name, description = v_description where id = v_list.id
  returning * into v_after;
  v_changes := private.diff(to_jsonb(v_list), to_jsonb(v_after), array['name', 'description']);
  if v_changes <> '{}'::jsonb then
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'price_list', v_list.id, private.price_list_label(v_after),
      format('Modificó la lista de precios %s', private.price_list_label(v_after)), null, null, null, v_changes);
  end if;
end;
$$;

-- Una lista desactivada deja de proponerse a sus clientes (cmdSetPriceListActive).
create function public.pl_set_active(p_company_id uuid, p_price_list_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'price_list.update');
  v_list public.price_lists := private.price_list_for(p_company_id, p_price_list_id::text);
begin
  if p_active is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá si la lista está activa.');
  end if;
  if v_list.is_active = p_active then
    return;
  end if;
  update public.price_lists set is_active = p_active where id = v_list.id;
  perform private.log_audit(p_company_id, v_actor, case when p_active then 'ACTIVATE' else 'DEACTIVATE' end, 'price_list',
    v_list.id, private.price_list_label(v_list),
    format('%s la lista de precios %s', case when p_active then 'Activó' else 'Desactivó' end, private.price_list_label(v_list)));
end;
$$;

-- Pone, cambia o saca (precio null) el precio de un producto en una lista (cmdSetPriceListPrice).
create function public.pl_set_price(p_company_id uuid, p_price_list_id uuid, p_product_id uuid, p_price numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'price_list.update');
  v_list public.price_lists := private.price_list_for(p_company_id, p_price_list_id::text);
  v_p public.products := private.product_for(p_company_id, p_product_id);
  v_item public.price_list_items;
  v_summary text;
begin
  if v_p.product_type not in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO') then
    perform private.raise_business_error('DATO_INVALIDO',
      format('%s es %s: no se vende.', v_p.code,
             case v_p.product_type when 'MATERIA_PRIMA' then 'materia prima' when 'INSUMO' then 'insumo' else lower(v_p.product_type) end),
      'En las listas de precios van los productos terminados, las mercaderías de reventa y los servicios.');
  end if;
  select * into v_item from public.price_list_items i where i.price_list_id = v_list.id and i.product_id = v_p.id;
  if p_price is null then
    if v_item.id is null then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s no está en la lista %s.', v_p.code, private.price_list_label(v_list)));
    end if;
    delete from public.price_list_items where id = v_item.id;
    v_summary := format('Sacó %s de la lista de precios %s', v_p.code, private.price_list_label(v_list));
  else
    if p_price <= 0 or round(p_price, 2) <> p_price or p_price >= 1000000000000 then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El precio de %s debe ser mayor que cero y tener hasta 2 decimales.', v_p.code));
    end if;
    if v_item.id is not null and v_item.unit_price = p_price then
      return;
    end if;
    if v_item.id is not null then
      v_summary := format('Cambió el precio de %s en la lista %s: de %s a %s', v_p.code, private.price_list_label(v_list),
                          private.format_money(v_item.unit_price), private.format_money(p_price));
      update public.price_list_items set unit_price = p_price where id = v_item.id;
    else
      v_summary := format('Agregó %s a la lista de precios %s a %s', v_p.code, private.price_list_label(v_list),
                          private.format_money(p_price));
      insert into public.price_list_items (company_id, price_list_id, product_id, unit_price)
      values (p_company_id, v_list.id, v_p.id, p_price);
    end if;
  end if;
  -- La lista queda con la fecha y el autor del cambio.
  update public.price_lists set name = name where id = v_list.id;
  perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'price_list', v_list.id, private.price_list_label(v_list), v_summary);
end;
$$;

-- Actualiza todos los precios de una lista por un porcentaje (cmdAdjustPriceList).
create function public.pl_adjust(p_company_id uuid, p_price_list_id uuid, p_percent numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'price_list.update');
  v_list public.price_lists := private.price_list_for(p_company_id, p_price_list_id::text);
  v_count int;
  v_zero text;
begin
  perform private.valid_percent(p_percent);
  if p_percent = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá un porcentaje distinto de cero.');
  end if;
  select count(*) into v_count from public.price_list_items i where i.price_list_id = v_list.id;
  if v_count = 0 then
    perform private.raise_business_error('DATO_INVALIDO',
      format('La lista %s todavía no tiene productos.', private.price_list_label(v_list)));
  end if;
  select p.code into v_zero
    from public.price_list_items i join public.products p on p.id = i.product_id
   where i.price_list_id = v_list.id and private.adjusted_price(i.unit_price, p_percent) <= 0
   order by p.code collate "C"
   limit 1;
  if v_zero is not null then
    perform private.raise_business_error('DATO_INVALIDO', format('El precio de %s quedaría en cero: usá un porcentaje menor.', v_zero));
  end if;
  update public.price_list_items set unit_price = private.adjusted_price(unit_price, p_percent) where price_list_id = v_list.id;
  update public.price_lists set name = name where id = v_list.id;
  perform private.log_audit(p_company_id, v_actor, 'UPDATE', 'price_list', v_list.id, private.price_list_label(v_list),
    format('Actualizó la lista de precios %s un %s (%s productos)', private.price_list_label(v_list),
           private.percent_label(p_percent), v_count));
end;
$$;

grant execute on function public.pl_create(uuid, jsonb) to authenticated;
grant execute on function public.pl_update(uuid, uuid, jsonb) to authenticated;
grant execute on function public.pl_set_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.pl_set_price(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function public.pl_adjust(uuid, uuid, numeric) to authenticated;

-- ------------------------------------------------------------------ Clientes: la lista de precios en la ficha

-- Igual que antes, y además la lista de precios del cliente: activa y de la empresa (salvo que ya la tuviera).
create or replace function public.master_save(p_kind text, p_company_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_data ->> 'id', '')::uuid;
  v_code text := upper(trim(coalesce(p_data ->> 'code', '')));
  v_table text;
  v_label text;
  v_name_field text;
  v_keys text[];
  v_actor private.actor;
  v_data jsonb;
  v_exists boolean;
  v_before jsonb;
  v_after jsonb;
  v_columns text;
  v_entity text;
begin
  case p_kind
    when 'customer' then
      v_table := 'customers'; v_label := 'cliente'; v_name_field := 'legal_name';
      v_keys := array['legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province',
                      'phone', 'email', 'contact_name', 'payment_terms_days', 'credit_limit', 'price_list_id', 'notes'];
    when 'supplier' then
      v_table := 'suppliers'; v_label := 'proveedor'; v_name_field := 'legal_name';
      v_keys := array['legal_name', 'trade_name', 'tax_id', 'vat_condition', 'address_line', 'city', 'province',
                      'phone', 'email', 'contact_name', 'payment_terms_days', 'lead_time_days', 'category', 'notes'];
    when 'product' then
      v_table := 'products'; v_label := 'producto'; v_name_field := 'name';
      v_keys := array['name', 'description', 'category', 'product_type', 'uom_code', 'standard_cost', 'sale_price',
                      'vat_rate', 'min_stock', 'reorder_qty', 'default_supplier_id', 'default_warehouse_id', 'location'];
    else
      perform private.raise_business_error('DATO_INVALIDO', 'Tipo de maestro desconocido.');
  end case;

  v_actor := private.require_permission(p_company_id, p_kind || '.' || case when v_id is null then 'create' else 'update' end);

  if v_code = '' then
    perform private.raise_business_error('DATO_INVALIDO', 'Ingresá el código.');
  end if;
  execute format('select exists (select 1 from public.%I where company_id = $1 and code = $2 and id is distinct from $3)', v_table)
     into v_exists using p_company_id, v_code, v_id;
  if v_exists then
    perform private.raise_business_error('DATO_INVALIDO', format('Ya existe un %s con el código %s.', v_label, v_code));
  end if;
  if length(trim(coalesce(p_data ->> v_name_field, ''))) < 2 then
    perform private.raise_business_error('DATO_INVALIDO',
      case when p_kind = 'product' then 'Ingresá la descripción del producto.' else 'Ingresá la razón social.' end);
  end if;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_data
    from jsonb_each(p_data) where key = any (v_keys);
  v_data := v_data || jsonb_build_object('code', v_code);

  if p_kind = 'product' then
    if v_id is null and coalesce(v_data ->> 'product_type', '') = '' then
      perform private.raise_business_error('DATO_INVALIDO', 'Elegí el tipo de producto.');
    end if;
    if v_data ? 'product_type' then
      v_data := v_data || jsonb_build_object('is_stockable', v_data ->> 'product_type' <> 'SERVICIO');
    end if;
    if nullif(v_data ->> 'default_supplier_id', '') is not null and not exists (
      select 1 from public.suppliers s where s.company_id = p_company_id and s.id = (v_data ->> 'default_supplier_id')::uuid
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'El proveedor habitual no existe en esta empresa.');
    end if;
    if nullif(v_data ->> 'default_warehouse_id', '') is not null and not exists (
      select 1 from public.warehouses w where w.company_id = p_company_id and w.id = (v_data ->> 'default_warehouse_id')::uuid
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'El depósito habitual no existe en esta empresa.');
    end if;
    -- "" en un id opcional significa "sin proveedor/depósito".
    v_data := v_data
      || case when v_data ? 'default_supplier_id' and v_data ->> 'default_supplier_id' = '' then '{"default_supplier_id": null}'::jsonb else '{}' end
      || case when v_data ? 'default_warehouse_id' and v_data ->> 'default_warehouse_id' = '' then '{"default_warehouse_id": null}'::jsonb else '{}' end;
  end if;

  if p_kind = 'customer' then
    -- "" en la lista de precios es "sin lista"; una desactivada no se asigna (salvo que el cliente ya la tuviera).
    if nullif(v_data ->> 'price_list_id', '') is not null and not exists (
      select 1 from public.price_lists l
       where l.company_id = p_company_id and l.id::text = v_data ->> 'price_list_id'
         and (l.is_active or l.id is not distinct from (select c.price_list_id from public.customers c where c.id = v_id))
    ) then
      perform private.raise_business_error('DATO_INVALIDO', 'La lista de precios debe estar activa y pertenecer a esta empresa.');
    end if;
    v_data := v_data
      || case when v_data ? 'price_list_id' and coalesce(v_data ->> 'price_list_id', '') = '' then '{"price_list_id": null}'::jsonb else '{}' end;
  end if;

  select string_agg(quote_ident(k), ', ') into v_columns from jsonb_object_keys(v_data) as k;

  if v_id is null then
    execute format(
      'insert into public.%1$I (company_id, %2$s) select $1, %2$s from jsonb_populate_record(null::public.%1$I, $2) returning id, to_jsonb(%1$I)',
      v_table, v_columns
    ) into v_id, v_after using p_company_id, v_data;
    v_entity := (v_after ->> 'code') || ' ' || (v_after ->> v_name_field);
    perform private.log_audit(p_company_id, v_actor, 'CREATE', p_kind, v_id, v_entity,
      format('Dio de alta el %s %s', v_label, v_entity));
    return v_id;
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.company_id = $2 for update', v_table)
     into v_before using v_id, p_company_id;
  if v_before is null then
    perform private.raise_business_error('DATO_INVALIDO', format('El %s no existe.', v_label));
  end if;
  execute format(
    'update public.%1$I t set (%2$s) = (select %2$s from jsonb_populate_record(null::public.%1$I, $1)) where t.id = $2 returning to_jsonb(t)',
    v_table, v_columns
  ) into v_after using v_data, v_id;
  v_entity := (v_after ->> 'code') || ' ' || (v_after ->> v_name_field);
  if private.diff(v_before, v_after, array(select jsonb_object_keys(v_data))) <> '{}'::jsonb then
    perform private.log_audit(p_company_id, v_actor, 'UPDATE', p_kind, v_id, v_entity,
      format('Modificó el %s %s', v_label, v_entity), null, null, null,
      private.diff(v_before, v_after, array(select jsonb_object_keys(v_data))));
  end if;
  return v_id;
end;
$$;

-- ------------------------------------------------------------------ Pedidos y presupuestos: lo común

-- Controla lo común del pedido y del presupuesto: cliente, depósito, condición de
-- pago, fecha de entrega, referencia e ítems (validateSalesOrder). Devuelve
-- {customer_id, warehouse_id, terms, delivery_date, reference, lines: [{product_id, quantity, unit_price, vat_rate, subtotal, tax}]}.
create function private.sales_input(p_company_id uuid, p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company public.companies;
  v_customer public.customers;
  v_terms numeric;
  v_delivery date;
  v_reference text := trim(coalesce(p_input ->> 'customer_reference', ''));
  v_line jsonb;
  v_p public.products;
  v_seen uuid[] := '{}';
  v_quantity numeric;
  v_price numeric;
  v_vat numeric;
  v_subtotal numeric;
  v_lines jsonb := '[]';
begin
  select * into v_company from public.companies c where c.id = p_company_id;
  select * into v_customer from public.customers c where c.company_id = p_company_id and c.id::text = p_input ->> 'customer_id';
  if not found then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el cliente.');
  end if;
  if not v_customer.is_active then
    perform private.raise_business_error('DATO_INVALIDO', format('El cliente %s está inactivo.', v_customer.legal_name));
  end if;
  if not exists (select 1 from public.warehouses w where w.company_id = p_company_id and w.id::text = p_input ->> 'warehouse_id') then
    perform private.raise_business_error('DATO_INVALIDO', 'Elegí el depósito desde el que se entrega.');
  end if;
  v_terms := (p_input ->> 'payment_terms_days')::numeric;
  if v_terms is null or v_terms < 0 or v_terms > 365 or v_terms <> trunc(v_terms) then
    perform private.raise_business_error('DATO_INVALIDO', 'La condición de pago es una cantidad entera de días, de 0 (contado) a 365.');
  end if;
  if p_input ->> 'delivery_date' is not null then
    v_delivery := private.parse_date(p_input ->> 'delivery_date');
    if v_delivery is null then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha de entrega no es válida.');
    end if;
    if v_delivery < private.business_date(p_company_id) then
      perform private.raise_business_error('DATO_INVALIDO', 'La fecha de entrega pedida no puede ser anterior a hoy.');
    end if;
  end if;
  if length(v_reference) > 60 then
    perform private.raise_business_error('DATO_INVALIDO', 'La referencia del cliente tiene hasta 60 caracteres.');
  end if;
  for v_line in
    select l from jsonb_array_elements(coalesce(p_input -> 'lines', '[]')) with ordinality as x (l, ord)
     where nullif(l ->> 'product_id', '') is not null
     order by ord
  loop
    select * into v_p from public.products p where p.company_id = p_company_id and p.id::text = v_line ->> 'product_id';
    if not found then
      perform private.raise_business_error('PRODUCTO_INEXISTENTE', 'El producto no existe en esta empresa.');
    end if;
    if not v_p.is_active then
      perform private.raise_business_error('DATO_INVALIDO', format('%s %s está inactivo.', v_p.code, v_p.name));
    end if;
    if v_p.product_type not in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO') then
      perform private.raise_business_error('DATO_INVALIDO',
        format('%s es %s: no se vende.', v_p.code,
               case v_p.product_type when 'MATERIA_PRIMA' then 'materia prima' when 'INSUMO' then 'insumo' else lower(v_p.product_type) end),
        'Se venden los productos terminados, las mercaderías de reventa y los servicios.');
    end if;
    if v_p.id = any (v_seen) then
      perform private.raise_business_error('DATO_INVALIDO', format('%s está dos veces: sumá las cantidades en un solo ítem.', v_p.code));
    end if;
    v_seen := v_seen || v_p.id;
    v_quantity := (v_line ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or round(v_quantity, 3) <> v_quantity then
      perform private.raise_business_error('DATO_INVALIDO',
        format('La cantidad de %s debe ser mayor que cero y tener hasta 3 decimales.', v_p.code));
    end if;
    v_price := (v_line ->> 'unit_price')::numeric;
    if v_price is null or v_price <= 0 or round(v_price, 4) <> v_price then
      perform private.raise_business_error('DATO_INVALIDO',
        format('El precio de %s debe ser mayor que cero y tener hasta 4 decimales.', v_p.code));
    end if;
    -- Quien no es responsable inscripto no factura IVA: su precio es el final.
    v_vat := case when v_company.vat_condition = 'RESPONSABLE_INSCRIPTO' then v_p.vat_rate else 0 end;
    if v_quantity * v_price * (1 + v_vat / 100) >= 1000000000000 then
      perform private.raise_business_error('DATO_INVALIDO', format('El importe de %s es demasiado grande.', v_p.code));
    end if;
    v_subtotal := round(v_quantity * v_price, 2);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_p.id, 'quantity', v_quantity, 'unit_price', v_price, 'vat_rate', v_vat,
      'subtotal', v_subtotal, 'tax', round(v_subtotal * v_vat / 100, 2)));
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    perform private.raise_business_error('DATO_INVALIDO', 'Agregá al menos un ítem.');
  end if;
  return jsonb_build_object('customer_id', v_customer.id, 'warehouse_id', p_input ->> 'warehouse_id', 'terms', v_terms::int,
                            'delivery_date', v_delivery, 'reference', v_reference, 'lines', v_lines);
end;
$$;

-- Carga el pedido en borrador. El precio de lista de cada ítem es el de la
-- lista del cliente o, si sale de un presupuesto (p_list_prices: {product_id:
-- precio}), el que se le propuso en él (insertSalesOrder).
create function private.insert_sales_order(p_company_id uuid, p_actor private.actor, p_input jsonb, p_list_prices jsonb default null)
returns public.documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input jsonb := private.sales_input(p_company_id, p_input);
  v_customer public.customers;
  v_number record;
  v_doc public.documents;
begin
  select * into v_customer from public.customers c where c.id = (v_input ->> 'customer_id')::uuid;
  select * into v_number from private.next_document_number(p_company_id, 'SALES_ORDER');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_ORDER', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (p_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (p_actor).user_id)
  returning * into v_doc;
  insert into public.sales_orders (document_id, company_id, warehouse_id, delivery_date, payment_terms_days, customer_reference)
  values (v_doc.id, p_company_id, (v_input ->> 'warehouse_id')::uuid, (v_input ->> 'delivery_date')::date,
          (v_input ->> 'terms')::int, v_input ->> 'reference');
  insert into public.sales_order_lines (company_id, document_id, line_no, product_id, quantity, list_price, unit_price, vat_rate,
                                        line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, x.ord, (x.l ->> 'product_id')::uuid, (x.l ->> 'quantity')::numeric,
         coalesce((p_list_prices ->> (x.l ->> 'product_id'))::numeric, private.list_price_for(v_customer.id, (x.l ->> 'product_id')::uuid)),
         (x.l ->> 'unit_price')::numeric, (x.l ->> 'vat_rate')::numeric,
         (x.l ->> 'subtotal')::numeric, (x.l ->> 'tax')::numeric, (x.l ->> 'subtotal')::numeric + (x.l ->> 'tax')::numeric
    from jsonb_array_elements(v_input -> 'lines') with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.sales_order_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.log_audit(p_company_id, p_actor, 'CREATE', 'sales_order', v_doc.id, v_doc.display_number,
    format('Creó %s a %s por %s', v_doc.display_number, v_customer.legal_name, private.format_money(v_doc.total)),
    v_doc.id, null, 'BORRADOR');
  return v_doc;
end;
$$;

-- Igual que antes: el precio de lista de cada ítem sale de la lista del cliente (cmdCreateSalesOrder).
create or replace function public.so_create(p_company_id uuid, p_input jsonb, p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_order.create');
  v_doc public.documents := private.insert_sales_order(p_company_id, v_actor, p_input);
begin
  if p_confirm then
    perform private.confirm_sales_order(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

-- ------------------------------------------------------------------ Presupuestos

-- La oferta venció: ya pasó el día hasta el que valía (quoteExpired).
create function private.sales_quote_expired(p_doc public.documents)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select q.valid_until < private.business_date(p_doc.company_id) from public.sales_quotes q where q.document_id = p_doc.id
$$;

-- El pedido que nació de un presupuesto aceptado (orderFromSalesQuote).
create function private.order_from_sales_quote(p_quote uuid)
returns public.documents
language sql
stable
security definer
set search_path = ''
as $$
  select d.* from public.document_links k join public.documents d on d.id = k.to_document_id
   where k.from_document_id = p_quote and d.doc_type = 'SALES_ORDER'
   order by d.number
   limit 1
$$;

-- Se envía al cliente mientras la oferta está vigente (sendSalesQuote).
create function private.send_sales_quote(p_doc public.documents)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_qt public.sales_quotes;
begin
  perform private.require_transition(p_doc, 'SEND');
  select * into v_qt from public.sales_quotes q where q.document_id = p_doc.id;
  if private.sales_quote_expired(p_doc) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s valía hasta el %s: anulalo y prepará otro con los precios del día.', p_doc.display_number,
             to_char(v_qt.valid_until, 'DD/MM/YYYY')));
  end if;
  perform private.transition_document(p_doc.id, 'SEND',
    p_summary => format('Envió %s a %s: %s, válido hasta el %s', p_doc.display_number,
                        (select c.legal_name from public.customers c where c.id = p_doc.customer_id),
                        private.format_money(p_doc.total), to_char(v_qt.valid_until, 'DD/MM/YYYY')));
end;
$$;

-- p_input: {customer_id, warehouse_id, valid_until, payment_terms_days, customer_reference, notes,
--           lines: [{product_id, quantity, unit_price}]} (cmdCreateSalesQuote)
create function public.pre_create(p_company_id uuid, p_input jsonb, p_send boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor private.actor := private.require_permission(p_company_id, 'sales_quote.create');
  v_input jsonb := private.sales_input(p_company_id, p_input - 'delivery_date');
  v_valid date := private.parse_date(p_input ->> 'valid_until');
  v_customer public.customers;
  v_number record;
  v_doc public.documents;
begin
  if v_valid is null then
    perform private.raise_business_error('DATO_INVALIDO', 'Indicá hasta cuándo vale la oferta.');
  end if;
  if v_valid < private.business_date(p_company_id) then
    perform private.raise_business_error('DATO_INVALIDO', 'La validez de la oferta no puede ser anterior a hoy.');
  end if;
  select * into v_customer from public.customers c where c.id = (v_input ->> 'customer_id')::uuid;
  select * into v_number from private.next_document_number(p_company_id, 'SALES_QUOTE');
  insert into public.documents (company_id, doc_type, number, display_number, status, document_date, sector_id, customer_id, notes, created_by)
  values (p_company_id, 'SALES_QUOTE', v_number.number, v_number.display_number, 'BORRADOR', private.business_date(p_company_id),
          (v_actor).sector_id, v_customer.id, trim(coalesce(p_input ->> 'notes', '')), (v_actor).user_id)
  returning * into v_doc;
  insert into public.sales_quotes (document_id, company_id, valid_until, warehouse_id, payment_terms_days, customer_reference)
  values (v_doc.id, p_company_id, v_valid, (v_input ->> 'warehouse_id')::uuid, (v_input ->> 'terms')::int, v_input ->> 'reference');
  insert into public.sales_quote_lines (company_id, document_id, line_no, product_id, quantity, list_price, unit_price, vat_rate,
                                        line_subtotal, line_tax, line_total)
  select p_company_id, v_doc.id, x.ord, (x.l ->> 'product_id')::uuid, (x.l ->> 'quantity')::numeric,
         private.list_price_for(v_customer.id, (x.l ->> 'product_id')::uuid),
         (x.l ->> 'unit_price')::numeric, (x.l ->> 'vat_rate')::numeric,
         (x.l ->> 'subtotal')::numeric, (x.l ->> 'tax')::numeric, (x.l ->> 'subtotal')::numeric + (x.l ->> 'tax')::numeric
    from jsonb_array_elements(v_input -> 'lines') with ordinality as x (l, ord);
  update public.documents d
     set subtotal = t.sub, tax_total = t.tax, total = t.sub + t.tax
    from (select sum(l.line_subtotal) as sub, sum(l.line_tax) as tax
            from public.sales_quote_lines l where l.document_id = v_doc.id) as t
   where d.id = v_doc.id
  returning d.* into v_doc;
  perform private.log_audit(p_company_id, v_actor, 'CREATE', 'sales_quote', v_doc.id, v_doc.display_number,
    format('Creó %s: presupuesto a %s por %s, válido hasta el %s', v_doc.display_number, v_customer.legal_name,
           private.format_money(v_doc.total), to_char(v_valid, 'DD/MM/YYYY')),
    v_doc.id, null, 'BORRADOR');
  if p_send then
    perform private.send_sales_quote(v_doc);
  else
    perform private.open_tasks_for_status(v_doc.id, v_actor);
  end if;
  return private.created_result(v_doc.id);
end;
$$;

create function public.pre_send(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_QUOTE');
  perform private.require_permission(v_doc.company_id, 'sales_quote.create');
  perform private.send_sales_quote(v_doc);
end;
$$;

-- El cliente aceptó: si la oferta sigue vigente, se genera el pedido de venta
-- en borrador con los mismos ítems y precios, enlazado al presupuesto (cmdAcceptSalesQuote).
create function public.pre_accept(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_qt public.sales_quotes;
  v_actor private.actor;
  v_order public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_QUOTE');
  perform private.require_transition(v_doc, 'CONFIRM');
  perform private.require_permission(v_doc.company_id, 'sales_quote.create');
  v_actor := private.require_permission(v_doc.company_id, 'sales_order.create');
  select * into v_qt from public.sales_quotes q where q.document_id = v_doc.id;
  if private.sales_quote_expired(v_doc) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('La oferta de %s venció el %s: ya no se acepta. Prepará otro presupuesto con los precios del día.',
             v_doc.display_number, to_char(v_qt.valid_until, 'DD/MM/YYYY')));
  end if;
  v_order := private.insert_sales_order(v_doc.company_id, v_actor,
    jsonb_build_object(
      'customer_id', v_doc.customer_id, 'warehouse_id', v_qt.warehouse_id, 'delivery_date', null,
      'payment_terms_days', v_qt.payment_terms_days, 'customer_reference', v_qt.customer_reference,
      'notes', format('Según %s.', v_doc.display_number),
      'lines', (select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'quantity', l.quantity,
                                                    'unit_price', l.unit_price) order by l.line_no)
                  from public.sales_quote_lines l where l.document_id = v_doc.id)),
    (select jsonb_object_agg(l.product_id::text, l.list_price) from public.sales_quote_lines l where l.document_id = v_doc.id));
  perform private.link_documents(v_doc.company_id, v_doc.id, v_order.id);
  perform private.open_tasks_for_status(v_order.id, v_actor);
  perform private.transition_document(v_doc.id, 'CONFIRM', p_actor => v_actor,
    p_summary => format('Registró la aceptación de %s por %s: generó %s en borrador', v_doc.display_number,
                        (select c.legal_name from public.customers c where c.id = v_doc.customer_id), v_order.display_number));
  return private.created_result(v_order.id);
end;
$$;

-- El cliente no aceptó: queda el motivo (cmdRejectSalesQuote).
create function public.pre_reject(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_QUOTE');
  perform private.transition_document(v_doc.id, 'REJECT', p_reason,
    p_summary => format('Registró el rechazo de %s por %s — %s', v_doc.display_number,
                        coalesce((select c.legal_name from public.customers c where c.id = v_doc.customer_id), ''),
                        trim(coalesce(p_reason, ''))));
end;
$$;

-- Pasada la validez sin respuesta, Ventas lo da por vencido (cmdExpireSalesQuote).
create function public.pre_expire(p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
  v_qt public.sales_quotes;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_QUOTE');
  perform private.require_transition(v_doc, 'CLOSE');
  perform private.require_permission(v_doc.company_id, 'sales_quote.cancel');
  select * into v_qt from public.sales_quotes q where q.document_id = v_doc.id;
  if not private.sales_quote_expired(v_doc) then
    perform private.raise_business_error('TRANSICION_INVALIDA',
      format('%s vale hasta el %s: todavía no venció.', v_doc.display_number, to_char(v_qt.valid_until, 'DD/MM/YYYY')));
  end if;
  perform private.transition_document(v_doc.id, 'CLOSE',
    p_summary => format('Dio por vencido %s (valía hasta el %s)', v_doc.display_number, to_char(v_qt.valid_until, 'DD/MM/YYYY')));
end;
$$;

create function public.pre_cancel(p_document_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  perform private.require_active_user();
  v_doc := private.get_document(p_document_id, 'SALES_QUOTE');
  perform private.transition_document(v_doc.id, 'CANCEL', p_reason);
end;
$$;

grant execute on function public.pre_create(uuid, jsonb, boolean) to authenticated;
grant execute on function public.pre_send(uuid) to authenticated;
grant execute on function public.pre_accept(uuid) to authenticated;
grant execute on function public.pre_reject(uuid, text) to authenticated;
grant execute on function public.pre_expire(uuid) to authenticated;
grant execute on function public.pre_cancel(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Lecturas

-- Las listas de precios de la empresa, por código (listPriceLists).
create function public.price_lists_list(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'price_list.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'list', to_jsonb(l),
             'items', (select count(*) from public.price_list_items i where i.price_list_id = l.id),
             'customers', (select count(*) from public.customers c where c.price_list_id = l.id))
           order by l.code collate "C")
      from public.price_lists l where l.company_id = p_company_id
  ), '[]');
end;
$$;

-- Una lista de precios con sus productos, sus clientes y lo que le falta; null si no existe (priceListDetail).
create function public.price_list_detail(p_company_id uuid, p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_list public.price_lists;
begin
  perform private.require_read(p_company_id, 'price_list.read');
  select * into v_list from public.price_lists l where l.company_id = p_company_id and l.code = p_code;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'list', to_jsonb(v_list),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('product', private.price_list_product(p), 'unit_price', i.unit_price)
                       order by p.code collate "C")
        from public.price_list_items i join public.products p on p.id = i.product_id
       where i.price_list_id = v_list.id), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'legal_name', c.legal_name, 'is_active', c.is_active)
                       order by c.code collate "C")
        from public.customers c where c.company_id = p_company_id and c.price_list_id = v_list.id), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(private.price_list_product(p) order by p.code collate "C")
        from public.products p
       where p.company_id = p_company_id and p.is_active
         and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO')
         and not exists (select 1 from public.price_list_items i where i.price_list_id = v_list.id and i.product_id = p.id)),
      '[]'::jsonb)
  );
end;
$$;

-- Igual que antes, con la lista de precios activa de cada cliente (salesCustomers).
create or replace function public.sales_customers(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_read(p_company_id, 'sales_order.create');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'code', c.code, 'legal_name', c.legal_name, 'vat_condition', c.vat_condition,
             'payment_terms_days', c.payment_terms_days, 'credit_limit', c.credit_limit,
             'credit_used', private.customer_credit_used(c.id),
             'price_list', (select jsonb_build_object('id', l.id, 'code', l.code, 'name', l.name)
                              from public.price_lists l where l.id = c.price_list_id and l.is_active))
           order by c.code collate "C")
      from public.customers c where c.company_id = p_company_id and c.is_active
  ), '[]');
end;
$$;

-- Igual que antes, con el precio de cada producto en las listas activas, por código de lista (salesCatalog).
create or replace function public.sales_catalog(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ri boolean;
begin
  perform private.require_read(p_company_id, 'sales_order.create');
  select c.vat_condition = 'RESPONSABLE_INSCRIPTO' into v_ri from public.companies c where c.id = p_company_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name, 'uom_code', p.uom_code, 'product_type', p.product_type,
             'is_stockable', p.is_stockable, 'sale_price', p.sale_price,
             'vat_rate', case when v_ri then p.vat_rate else 0 end,
             'stock', case when p.is_stockable then private.availability_of(p_company_id, p.id) else '[]'::jsonb end,
             'list_prices', coalesce((
               select jsonb_agg(jsonb_build_object('price_list_id', i.price_list_id, 'unit_price', i.unit_price)
                                order by l.code collate "C")
                 from public.price_list_items i join public.price_lists l on l.id = i.price_list_id and l.is_active
                where i.product_id = p.id), '[]'::jsonb))
           order by p.code collate "C")
      from public.products p
     where p.company_id = p_company_id and p.is_active
       and p.product_type in ('PRODUCTO_TERMINADO', 'MERCADERIA_REVENTA', 'SERVICIO')
  ), '[]');
end;
$$;

grant execute on function public.price_lists_list(uuid) to authenticated;
grant execute on function public.price_list_detail(uuid, text) to authenticated;

-- ------------------------------------------------------------------ Documentos: el presupuesto en las lecturas comunes

-- Presupuesto: hasta cuándo vale la oferta y, si se aceptó, el pedido que generó (salesQuoteView).
create function private.sales_quote_view(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'valid_until', q.valid_until,
    'expired', p_doc.status in ('BORRADOR', 'ENVIADO') and private.sales_quote_expired(p_doc),
    'payment_terms_days', q.payment_terms_days,
    'customer_reference', q.customer_reference,
    'order', case when p_doc.status = 'ACEPTADO' then private.doc_ref((private.order_from_sales_quote(p_doc.id)).id) end)
    from public.sales_quotes q where q.document_id = p_doc.id
$$;

create or replace function private.document_json(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p_doc)
    || coalesce((
      select jsonb_build_object('pr', jsonb_build_object('needed_by', x.needed_by, 'priority', x.priority, 'reason', x.reason))
        from public.purchase_requisitions x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('po', jsonb_build_object(
               'expected_date', x.expected_date, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'delivery_terms', x.delivery_terms, 'approved_at', x.approved_at, 'sent_at', x.sent_at))
        from public.purchase_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('gr', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'warehouse_id', x.warehouse_id,
               'supplier_delivery_note', x.supplier_delivery_note, 'carrier_name', x.carrier_name, 'received_at', x.received_at))
        from public.goods_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sa', jsonb_build_object('warehouse_id', x.warehouse_id, 'reason_code', x.reason_code))
        from public.stock_adjustments x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('je', jsonb_build_object(
               'description', x.description, 'origin', x.origin, 'fiscal_year_id', x.fiscal_year_id,
               'entry_number', x.entry_number, 'posted_at', x.posted_at, 'reverses_id', x.reverses_id))
        from public.journal_entries x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('si', jsonb_build_object(
               'purchase_order_id', x.purchase_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.supplier_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('op', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_reference', x.payment_reference, 'paid_on', x.paid_on,
               'payment_method', x.payment_method))
        from public.payment_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rq', jsonb_build_object(
               'response_due', x.response_due, 'warehouse_id', x.warehouse_id, 'award_reason', x.award_reason))
        from public.rfqs x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('sq', jsonb_build_object(
               'rfq_id', x.rfq_id, 'supplier_reference', x.supplier_reference, 'valid_until', x.valid_until,
               'delivery_days', x.delivery_days, 'payment_terms_days', x.payment_terms_days))
        from public.supplier_quotes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('ft', jsonb_build_object(
               'from_account_id', x.from_account_id, 'to_account_id', x.to_account_id, 'reference', x.reference,
               'transferred_on', x.transferred_on))
        from public.funds_transfers x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('br', jsonb_build_object(
               'account_id', x.account_id, 'statement_date', x.statement_date, 'statement_balance', x.statement_balance,
               'book_balance', x.book_balance, 'pending_debits', x.pending_debits, 'pending_credits', x.pending_credits))
        from public.bank_reconciliations x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('so', jsonb_build_object(
               'warehouse_id', x.warehouse_id, 'delivery_date', x.delivery_date, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference, 'credit_reason', x.credit_reason, 'confirmed_at', x.confirmed_at))
        from public.sales_orders x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('dn', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'warehouse_id', x.warehouse_id, 'carrier_name', x.carrier_name,
               'dispatched_at', x.dispatched_at))
        from public.delivery_notes x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('fv', jsonb_build_object(
               'sales_order_id', x.sales_order_id, 'letter', x.letter, 'point_of_sale', x.point_of_sale,
               'invoice_number', x.invoice_number, 'due_date', x.due_date, 'registered_at', x.registered_at))
        from public.sales_invoices x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('rc', jsonb_build_object(
               'treasury_account_id', x.treasury_account_id, 'payment_method', x.payment_method, 'reference', x.reference,
               'received_on', x.received_on))
        from public.customer_receipts x where x.document_id = p_doc.id), '{}')
    || coalesce((
      select jsonb_build_object('qt', jsonb_build_object(
               'valid_until', x.valid_until, 'warehouse_id', x.warehouse_id, 'payment_terms_days', x.payment_terms_days,
               'customer_reference', x.customer_reference))
        from public.sales_quotes x where x.document_id = p_doc.id), '{}')
$$;

-- Igual que antes, con los ítems del presupuesto.
create or replace function private.document_item(p_doc public.documents)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select l.line_no, l.product_id from public.purchase_requisition_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.purchase_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.goods_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.stock_adjustment_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.supplier_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.rfq_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.supplier_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.delivery_note_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_invoice_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, l.product_id from public.sales_quote_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.journal_entry_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.payment_order_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.customer_receipt_lines l where l.document_id = p_doc.id
    union all
    select l.line_no, null::uuid from public.bank_reconciliation_lines l where l.document_id = p_doc.id
  ),
  codes as (
    select array_agg(p.code order by l.line_no) as list, count(*) as n
      from lines l join public.products p on p.id = l.product_id
  ),
  invoices as (
    select array_agg(d.display_number order by l.line_no) as list, count(*) as n
      from (
        select x.line_no, x.invoice_id from public.payment_order_lines x where x.document_id = p_doc.id
        union all
        select x.line_no, x.invoice_id from public.customer_receipt_lines x where x.document_id = p_doc.id
      ) as l
      join public.documents d on d.id = l.invoice_id
  )
  select private.document_json(p_doc) || jsonb_build_object(
    'status_info', private.status_info(p_doc.doc_type, p_doc.status),
    'supplier_name', coalesce((select s.legal_name from public.suppliers s where s.id = p_doc.supplier_id), ''),
    'customer_name', coalesce((select c.legal_name from public.customers c where c.id = p_doc.customer_id), ''),
    'sector_name', coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), '—'),
    'created_by_name', private.full_name(p_doc.created_by),
    'line_count', (select count(*) from lines),
    'summary', coalesce(
      (select je.description from public.journal_entries je where je.document_id = p_doc.id),
      case when p_doc.doc_type in ('PAYMENT_ORDER', 'CUSTOMER_RECEIPT') then
        (select coalesce(array_to_string(i.list[1:3], ', '), '') || case when i.n > 3 then format(' y %s más', i.n - 3) else '' end
           from invoices i)
      end,
      (select fa.name || ' → ' || ta.name
         from public.funds_transfers t
         join public.accounts fa on fa.id = t.from_account_id
         join public.accounts ta on ta.id = t.to_account_id
        where t.document_id = p_doc.id),
      (select a.name || ' al ' || to_char(r.statement_date, 'DD/MM/YYYY')
         from public.bank_reconciliations r join public.accounts a on a.id = r.account_id
        where r.document_id = p_doc.id),
      (select coalesce(array_to_string(c.list[1:3], ', '), '') || case when c.n > 3 then format(' y %s más', c.n - 3) else '' end
         from codes c)),
    'pending_approver', (
      select r.name from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id and a.status = 'PENDIENTE'),
    'reference_label', (
      select string_agg(o.display_number, ', ' order by o.display_number collate "C")
        from public.document_links k join public.documents o on o.id = k.from_document_id
       where k.to_document_id = p_doc.id),
    'path', private.doc_path(p_doc.id)
  )
$$;

-- Igual que antes, con el presupuesto según su validez (nextStep).
create or replace function private.next_step(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sector text := coalesce((select s.name from public.sectors s where s.id = p_doc.sector_id), 'el sector solicitante');
  v_req public.approval_requests;
  v_rule text;
  v_loaded int;
  v_invited int;
  v_awarded public.documents;
  v_rfq_number text;
begin
  case p_doc.doc_type || ':' || p_doc.status
    when 'PURCHASE_REQUISITION:BORRADOR' then
      return jsonb_build_object('who', v_sector,
        'text', 'Completar los ítems, justificar la necesidad y enviar la solicitud a Compras.');
    when 'PURCHASE_REQUISITION:SOLICITADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Debe pedir cotizaciones o incluir la solicitud en una orden de compra a un proveedor, o rechazarla indicando el motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO_PARCIAL' then
      return jsonb_build_object('who', 'Compras', 'text', 'Resta ordenar el saldo pendiente o cerrarlo con motivo.');
    when 'PURCHASE_REQUISITION:ORDENADO' then
      return jsonb_build_object('who', 'Compras y Depósito',
        'text', 'La necesidad ya está cubierta por órdenes de compra. Seguí su avance en "Flujo documental".');
    when 'PURCHASE_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar proveedor, precios, cantidades y fecha de entrega, y enviar la orden a aprobación.');
    when 'PURCHASE_ORDER:PENDIENTE_APROBACION' then
      select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
      select r.description into v_rule from public.approval_rules r where r.id = v_req.rule_id;
      return jsonb_build_object(
        'who', coalesce((select ro.name from public.roles ro where ro.code = v_req.approver_role), 'Aprobador'),
        'text', trim(coalesce(v_rule, '') || ' Quien creó la orden no puede aprobarla: es un control de separación de funciones.'));
    when 'PURCHASE_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Compras',
        'text', format('Motivo del rechazo: "%s". Reabrir, corregir y reenviar, o anular la orden.', p_doc.status_reason));
    when 'PURCHASE_ORDER:APROBADO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Comunicar la orden al proveedor (imprimirla o enviarla) y marcarla como enviada.');
    when 'PURCHASE_ORDER:ENVIADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Cuando llegue la mercadería, controlarla contra esta orden y el remito del proveedor, y registrar la recepción.');
    when 'PURCHASE_ORDER:RECIBIDO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Compras',
        'text', 'Falta recibir el saldo. Si no va a llegar, Compras puede cerrar el saldo con motivo.');
    when 'PURCHASE_ORDER:RECIBIDO' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Llegó todo lo pedido. Cuando llegue la factura del proveedor, se registra contra esta orden y lo recibido.');
    when 'GOODS_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Revisar cantidades contra el remito y confirmar la recepción para que ingrese al stock.');
    when 'GOODS_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería ingresó al stock (ver kardex). Compras y el solicitante fueron notificados.');
    when 'STOCK_ADJUSTMENT:BORRADOR' then
      return jsonb_build_object('who', 'Depósito', 'text', 'Revisar y confirmar el ajuste.');
    when 'STOCK_ADJUSTMENT:CONFIRMADO' then
      return jsonb_build_object('who', '—', 'text', 'El ajuste impactó en el stock y quedó documentado.');
    when 'SUPPLIER_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Controlar el comprobante del proveedor contra la orden de compra y lo recibido, y registrar la factura.');
    when 'SUPPLIER_INVOICE:REGISTRADA', 'SUPPLIER_INVOICE:PAGADA_PARCIAL' then
      return jsonb_build_object('who', 'Contabilidad y Tesorería',
        'text', format('La deuda está en la cuenta corriente del proveedor y vence el %s. Se cancela con una orden de pago.',
                       (select to_char(si.due_date, 'DD/MM/YYYY') from public.supplier_invoices si where si.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', 'Revisar las facturas, los importes y la caja o el banco, y enviar la orden a aprobación.');
    when 'PAYMENT_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', 'Autorizar el pago o rechazarlo con motivo. Quien preparó la orden no puede aprobarla: es un control de separación de funciones.');
    when 'PAYMENT_ORDER:APROBADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('Pagar desde %s y registrar el pago: el asiento se genera solo. Quien registró una de las facturas no puede pagarla.',
                       coalesce((select a.code || ' ' || a.name from public.payment_orders po
                                   join public.accounts a on a.id = po.treasury_account_id
                                  where po.document_id = p_doc.id), 'la caja o el banco')));
    when 'PAYMENT_ORDER:PAGADA' then
      return jsonb_build_object('who', '—',
        'text', format('Se pagó el %s: la deuda bajó en la cuenta corriente del proveedor y el pago está en el libro diario.',
                       (select to_char(po.paid_on, 'DD/MM/YYYY') from public.payment_orders po where po.document_id = p_doc.id)));
    when 'PAYMENT_ORDER:RECHAZADA' then
      return jsonb_build_object('who', 'Contabilidad o Tesorería',
        'text', format('Motivo del rechazo: "%s". Si igual hay que pagar, se prepara otra orden.', p_doc.status_reason));
    when 'RFQ:BORRADOR' then
      return jsonb_build_object('who', 'Compras',
        'text', 'Revisar los ítems, las cantidades y los proveedores invitados, y enviar la solicitud. Si algo está mal, se anula y se prepara otra.');
    when 'RFQ:ENVIADA' then
      select count(*) into v_loaded from private.rfq_quotes(p_doc.id);
      select count(*) into v_invited from public.rfq_suppliers s where s.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras', 'text', case when v_loaded > 0
        then format('Hay %s de %s cotizaciones cargadas. Compararlas en el cuadro y adjudicar: se genera la orden de compra en borrador. Si no es la más conveniente por precio, hay que justificar la elección.',
                    v_loaded, v_invited)
        else format('Mandar la solicitud impresa a cada proveedor invitado y cargar sus cotizaciones a medida que lleguen (responden hasta el %s).',
                    (select to_char(r.response_due, 'DD/MM/YYYY') from public.rfqs r where r.document_id = p_doc.id))
      end);
    when 'RFQ:ADJUDICADA' then
      select * into v_awarded from private.rfq_quotes(p_doc.id) q where q.status = 'ADJUDICADA' order by q.number limit 1;
      return jsonb_build_object('who', 'Compras',
        'text', format('Se adjudicó a %s (%s) y se generó %s: la compra sigue en esa orden.',
                       coalesce((select s.legal_name from public.suppliers s where s.id = v_awarded.supplier_id), '—'),
                       coalesce(v_awarded.display_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(v_awarded.id)),
                                'la orden de compra')));
    when 'SUPPLIER_QUOTE:RECIBIDA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', 'Compras',
        'text', format('Participa del cuadro comparativo de %s. Se adjudica desde la solicitud; si se cargó mal, se anula y se carga de nuevo.',
                       coalesce(v_rfq_number, '—')));
    when 'SUPPLIER_QUOTE:ADJUDICADA' then
      select r.display_number into v_rfq_number
        from public.supplier_quotes q join public.documents r on r.id = q.rfq_id where q.document_id = p_doc.id;
      return jsonb_build_object('who', '—',
        'text', format('Fue la elegida en %s: de ella nació %s.', coalesce(v_rfq_number, '—'),
                       coalesce((select d.display_number from public.documents d where d.id = private.order_from_quote(p_doc.id)),
                                'la orden de compra')));
    when 'BANK_RECONCILIATION:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Cierra con el extracto al %s. Lo pendiente (%s en pagos sin debitar y %s en entradas sin acreditar) se controla en la próxima conciliación.',
                               to_char(r.statement_date, 'DD/MM/YYYY'), private.format_money(r.pending_credits),
                               private.format_money(r.pending_debits))
                   from public.bank_reconciliations r where r.document_id = p_doc.id));
    when 'FUNDS_TRANSFER:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las cuentas y el importe, y confirmar la transferencia: se controla el saldo de la cuenta de origen y se genera el asiento.');
    when 'FUNDS_TRANSFER:CONFIRMADA' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se transfirió el %s de %s a %s: el movimiento está en el libro diario y no cambia el total de los fondos.',
                               coalesce(to_char(t.transferred_on, 'DD/MM/YYYY'), '—'), fa.name, ta.name)
                   from public.funds_transfers t
                   join public.accounts fa on fa.id = t.from_account_id
                   join public.accounts ta on ta.id = t.to_account_id
                  where t.document_id = p_doc.id));
    when 'SALES_ORDER:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar el cliente, los ítems, los precios y el depósito, y confirmar el pedido: se controla el stock disponible y el crédito del cliente, y se reserva la mercadería.');
    when 'SALES_ORDER:PENDIENTE_APROBACION' then
      return jsonb_build_object('who', 'Gerencia',
        'text', trim(coalesce((select so.credit_reason from public.sales_orders so where so.document_id = p_doc.id), '')
                     || ' Autorizar el crédito o rechazar el pedido con motivo; mientras tanto, la mercadería queda reservada. Quien cargó el pedido no puede autorizarlo: es un control de separación de funciones.'));
    when 'SALES_ORDER:CONFIRMADO' then
      return jsonb_build_object('who', 'Depósito',
        'text', format('La mercadería está reservada en %s. Prepararla, cargar el remito y despacharlo.',
                       coalesce((select w.name from public.sales_orders so join public.warehouses w on w.id = so.warehouse_id
                                  where so.document_id = p_doc.id), 'el depósito')));
    when 'SALES_ORDER:ENTREGADO_PARCIAL' then
      return jsonb_build_object('who', 'Depósito o Ventas',
        'text', 'Falta entregar el saldo, que sigue reservado. Si no se va a entregar, Ventas puede cerrar el saldo con motivo.');
    when 'SALES_ORDER:ENTREGADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas', 'text', 'Se entregó todo lo pedido: falta facturar lo entregado.');
      end if;
      return jsonb_build_object('who', '—',
        'text', 'Se entregó y se facturó todo lo pedido: la deuda está en la cuenta corriente del cliente.');
    when 'SALES_ORDER:CERRADO' then
      if private.uninvoiced_delivery(p_doc.id) then
        return jsonb_build_object('who', 'Ventas',
          'text', 'Se cerró con saldo sin entregar: falta facturar lo que sí se entregó.');
      end if;
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = 'SALES_ORDER' and s.code = 'CERRADO'), ''));
    when 'SALES_INVOICE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas',
        'text', 'Revisar las cantidades contra lo entregado y registrar la factura: se le asigna el número y se generan el asiento de venta y la deuda del cliente.');
    when 'SALES_INVOICE:REGISTRADA' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('La deuda está en la cuenta corriente del cliente y vence el %s. Se cancela cuando el cliente paga, con un recibo de cobro.',
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'SALES_INVOICE:COBRADA_PARCIAL' then
      return jsonb_build_object('who', 'Tesorería',
        'text', format('El cliente pagó una parte: quedan %s en su cuenta corriente (vence el %s). El saldo se cancela con otro recibo de cobro.',
                       private.format_money(private.sales_invoice_pending(p_doc.id)),
                       (select to_char(x.due_date, 'DD/MM/YYYY') from public.sales_invoices x where x.document_id = p_doc.id)));
    when 'SALES_QUOTE:BORRADOR' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('Venció el %s: anularlo y, si hace falta, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else 'Revisar los ítems, los precios y la validez, e imprimir el presupuesto para enviárselo al cliente.'
      end);
    when 'SALES_QUOTE:ENVIADO' then
      return jsonb_build_object('who', 'Ventas', 'text', case when private.sales_quote_expired(p_doc)
        then format('La oferta venció el %s: darlo por vencido y, si el cliente sigue interesado, preparar otro con los precios del día.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
        else format('El cliente tiene hasta el %s para responder. Si acepta, se registra la aceptación y se genera el pedido de venta; si no, el rechazo con su motivo.',
                    (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id))
      end);
    when 'SALES_QUOTE:ACEPTADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('El cliente lo aceptó: se generó %s en borrador. Ventas lo revisa y lo confirma: ahí se controlan el stock y el crédito.',
                       coalesce((private.order_from_sales_quote(p_doc.id)).display_number, 'el pedido de venta')));
    when 'SALES_QUOTE:RECHAZADO' then
      return jsonb_build_object('who', '—', 'text', format('Motivo del cliente: "%s".', p_doc.status_reason));
    when 'CUSTOMER_RECEIPT:BORRADOR' then
      return jsonb_build_object('who', 'Tesorería',
        'text', 'Revisar las facturas, los importes, el medio de cobro y la caja o el banco, y confirmar el cobro: se genera el asiento y baja la deuda del cliente. Quien emitió una de las facturas no puede registrar su cobro.');
    when 'CUSTOMER_RECEIPT:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', (select format('Se cobró el %s: la deuda bajó en la cuenta corriente del cliente y el cobro está en el libro diario.%s',
                               coalesce(to_char(x.received_on, 'DD/MM/YYYY'), '—'),
                               case when x.payment_method = 'CHEQUE'
                                 then ' Para depositar el cheque en el banco, Tesorería prepara una transferencia entre cuentas.' else '' end)
                   from public.customer_receipts x where x.document_id = p_doc.id));
    when 'SALES_ORDER:RECHAZADO' then
      return jsonb_build_object('who', 'Ventas',
        'text', format('Motivo del rechazo: "%s". Si el cliente achica el pedido o paga lo que debe, se carga otro.', p_doc.status_reason));
    when 'DELIVERY_NOTE:BORRADOR' then
      return jsonb_build_object('who', 'Depósito',
        'text', 'Preparar la mercadería, controlarla contra el remito y despacharlo: baja el stock, se libera la reserva y se registra el costo de lo vendido.');
    when 'DELIVERY_NOTE:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', 'La mercadería salió: bajó el stock (ver kardex), el costo de lo vendido está en el libro diario y Ventas fue notificada.');
    when 'JOURNAL_ENTRY:BORRADOR' then
      return jsonb_build_object('who', 'Contabilidad',
        'text', 'Revisar que las cuentas sean las correctas y que el debe y el haber sumen lo mismo, y registrar el asiento en el libro diario.');
    when 'JOURNAL_ENTRY:CONFIRMADO' then
      return jsonb_build_object('who', '—',
        'text', format('Está en el libro diario con el N.º %s. Si tiene un error, no se corrige: se anula con un contraasiento y se registra el asiento correcto.',
                       (select je.entry_number from public.journal_entries je where je.document_id = p_doc.id)));
    else
      return jsonb_build_object('who', '—', 'text', coalesce((
        select s.description from public.document_statuses s where s.doc_type = p_doc.doc_type and s.code = p_doc.status), ''));
  end case;
end;
$$;

-- Igual que antes, con el presupuesto: sus ítems, su vista, su lugar en el flujo y sus firmas.
create or replace function private.document_detail(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines jsonb;
  v_warehouse uuid;
  v_order public.documents;
begin
  case p_doc.doc_type
    when 'PURCHASE_REQUISITION' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'qty_ordered', l.qty_ordered) order by l.line_no)
        into v_lines
        from public.purchase_requisition_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'PURCHASE_ORDER' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total, 'qty_received', l.qty_received, 'requisition_label', rd.display_number,
               'requisition_line_id', l.requisition_line_id,
               'requisition_max', case when rl.id is not null then rl.quantity - rl.qty_ordered + l.quantity end) order by l.line_no)
        into v_lines
        from public.purchase_order_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.purchase_orders x where x.document_id = p_doc.id;
    when 'GOODS_RECEIPT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.goods_receipt_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.goods_receipts x where x.document_id = p_doc.id;
      select d.* into v_order from public.goods_receipts x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'STOCK_ADJUSTMENT' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity_delta, 'notes', l.notes,
               'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.stock_adjustment_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.stock_adjustments x where x.document_id = p_doc.id;
    when 'SUPPLIER_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'po_line_id', l.po_line_id, 'qty_ordered_po', pl.quantity, 'qty_received', pl.qty_received,
               'unit_price', l.unit_price, 'order_unit_price', pl.unit_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_invoice_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_order_lines pl on pl.id = l.po_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.supplier_invoices x join public.documents d on d.id = x.purchase_order_id
       where x.document_id = p_doc.id;
    when 'RFQ' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'requisition_label', rd.display_number, 'requisition_line_id', l.requisition_line_id) order by l.line_no)
        into v_lines
        from public.rfq_lines l
        join public.products p on p.id = l.product_id
        left join public.purchase_requisition_lines rl on rl.id = l.requisition_line_id
        left join public.documents rd on rd.id = rl.document_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.rfqs x where x.document_id = p_doc.id;
    when 'SUPPLIER_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax,
               'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.supplier_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'SALES_ORDER' then
      select x.warehouse_id into v_warehouse from public.sales_orders x where x.document_id = p_doc.id;
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total,
               'qty_delivered', l.qty_delivered, 'qty_invoiced', private.sales_invoiced_quantity(l.id),
               'qty_available', case when p.is_stockable then
                 round(private.on_hand_quantity(p.id, v_warehouse) - private.reserved_quantity(p.id, v_warehouse, p_doc.id), 3)
               end) order by l.line_no)
        into v_lines
        from public.sales_order_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
    when 'DELIVERY_NOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', l.notes,
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', sl.unit_price, 'unit_cost', l.unit_cost) order by l.line_no)
        into v_lines
        from public.delivery_note_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.delivery_notes x where x.document_id = p_doc.id;
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_INVOICE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'so_line_id', l.so_line_id, 'qty_ordered_so', sl.quantity, 'qty_delivered', sl.qty_delivered,
               'unit_price', l.unit_price, 'vat_rate', l.vat_rate, 'line_subtotal', l.line_subtotal,
               'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_invoice_lines l
        join public.products p on p.id = l.product_id
        join public.sales_order_lines sl on sl.id = l.so_line_id
       where l.document_id = p_doc.id;
      select d.* into v_order from public.sales_invoices x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
    when 'SALES_QUOTE' then
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'line_no', l.line_no, 'product', to_jsonb(p), 'quantity', l.quantity, 'notes', '',
               'unit_price', l.unit_price, 'list_price', l.list_price, 'vat_rate', l.vat_rate,
               'line_subtotal', l.line_subtotal, 'line_tax', l.line_tax, 'line_total', l.line_total) order by l.line_no)
        into v_lines
        from public.sales_quote_lines l join public.products p on p.id = l.product_id
       where l.document_id = p_doc.id;
      select x.warehouse_id into v_warehouse from public.sales_quotes x where x.document_id = p_doc.id;
    else
      v_lines := null;
  end case;

  return jsonb_build_object(
    'doc', private.document_item(p_doc),
    'lines', coalesce(v_lines, '[]'),
    'journal', case when p_doc.doc_type = 'JOURNAL_ENTRY' then private.journal_view(p_doc) end,
    'payment', case when p_doc.doc_type = 'PAYMENT_ORDER' then private.payment_view(p_doc) end,
    'receipt', case when p_doc.doc_type = 'CUSTOMER_RECEIPT' then private.receipt_view(p_doc) end,
    'rfq', case when p_doc.doc_type = 'RFQ' then private.rfq_view(p_doc) end,
    'quote', case when p_doc.doc_type = 'SUPPLIER_QUOTE' then private.quote_view(p_doc) end,
    'transfer', case when p_doc.doc_type = 'FUNDS_TRANSFER' then private.transfer_view(p_doc) end,
    'reconciliation', case when p_doc.doc_type = 'BANK_RECONCILIATION' then private.reconciliation_view(p_doc) end,
    'sales_order', case when p_doc.doc_type = 'SALES_ORDER' then private.sales_order_view(p_doc) end,
    'sales_quote', case when p_doc.doc_type = 'SALES_QUOTE' then private.sales_quote_view(p_doc) end,
    'delivery', case when p_doc.doc_type = 'DELIVERY_NOTE' then private.delivery_view(p_doc) end,
    'supplier', (select to_jsonb(s) from public.suppliers s where s.id = p_doc.supplier_id),
    'customer', (select to_jsonb(c) from public.customers c where c.id = p_doc.customer_id),
    'warehouse', (select to_jsonb(w) from public.warehouses w where w.id = v_warehouse),
    'related_order', case when v_order.id is not null then private.document_item(v_order) end,
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(a) || jsonb_build_object(
               'approver_role_name', r.name,
               'decided_by_name', case when a.decided_by is not null then private.full_name(a.decided_by) else '' end,
               'requested_by_name', private.full_name(a.requested_by)) order by a.requested_at)
        from public.approval_requests a join public.roles r on r.code = a.approver_role
       where a.document_id = p_doc.id
    ), '[]'),
    'flow', (
      with recursive flow (id) as (
        select p_doc.id
        union
        select case when l.from_document_id = f.id then l.to_document_id else l.from_document_id end
          from flow f join public.document_links l on f.id in (l.from_document_id, l.to_document_id)
      )
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'doc_type', d.doc_type, 'display_number', d.display_number,
               'status_info', private.status_info(d.doc_type, d.status), 'path', private.doc_path(d.id),
               'current', d.id = p_doc.id, 'readable', d.doc_type = any (private.readable_doc_types(p_doc.company_id)),
               'date', d.created_at)
             order by array_position(
                        array['PURCHASE_REQUISITION', 'RFQ', 'SUPPLIER_QUOTE', 'PURCHASE_ORDER', 'GOODS_RECEIPT',
                              'SUPPLIER_INVOICE', 'PAYMENT_ORDER', 'FUNDS_TRANSFER', 'BANK_RECONCILIATION', 'SALES_QUOTE', 'SALES_ORDER',
                              'DELIVERY_NOTE', 'SALES_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'JOURNAL_ENTRY'],
                        d.doc_type),
                      d.number)
        from flow f join public.documents d on d.id = f.id
    ),
    'history', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id) from public.audit_events e where e.document_id = p_doc.id
    ), '[]'),
    'actions', private.available_actions(p_doc),
    'next_step', private.next_step(p_doc),
    'signatures', case p_doc.doc_type
      when 'PURCHASE_REQUISITION' then jsonb_build_array(
        private.signature(p_doc.id, 'Solicitó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Atendió (Compras)', array['SYSTEM']))
      when 'PURCHASE_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']))
      when 'JOURNAL_ENTRY' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      when 'SUPPLIER_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'PAYMENT_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó', array['APPROVE']),
        private.signature(p_doc.id, 'Pagó', array['PAY']))
      when 'RFQ' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['SUBMIT', 'CREATE']),
        private.signature(p_doc.id, 'Adjudicó', array['AWARD']))
      when 'SUPPLIER_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Cargó', array['CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'FUNDS_TRANSFER' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Confirmó', array['CONFIRM']))
      when 'BANK_RECONCILIATION' then jsonb_build_array(
        private.signature(p_doc.id, 'Concilió', array['CREATE']),
        jsonb_build_object('label', 'Revisó', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_ORDER' then jsonb_build_array(
        private.signature(p_doc.id, 'Vendió', array['CONFIRM', 'CREATE']),
        private.signature(p_doc.id, 'Autorizó el crédito', array['APPROVE']))
      when 'DELIVERY_NOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Despachó', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Recibió conforme (cliente)', 'name', '', 'sector', '', 'at', ''))
      when 'SALES_INVOICE' then jsonb_build_array(
        private.signature(p_doc.id, 'Emitió', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
      when 'CUSTOMER_RECEIPT' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        private.signature(p_doc.id, 'Cobró', array['CONFIRM']))
      when 'SALES_QUOTE' then jsonb_build_array(
        private.signature(p_doc.id, 'Preparó', array['CREATE']),
        jsonb_build_object('label', 'Conformidad del cliente', 'name', '', 'sector', '', 'at', ''))
      else jsonb_build_array(
        private.signature(p_doc.id, 'Recibió / registró', array['CONFIRM', 'CREATE']),
        jsonb_build_object('label', 'Controló', 'name', '', 'sector', '', 'at', ''))
    end
  );
end;
$$;

-- Igual que antes, con la validez del presupuesto: vencido no se envía ni se acepta, y sólo vencido se da por vencido.
create or replace function private.available_actions(p_doc public.documents)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_supervisor boolean := private.is_supervisor(p_doc.company_id);
  v_roles text[] := array(select private.my_role_codes(p_doc.company_id));
  v_sod boolean := coalesce((select (c.settings ->> 'sod_enabled')::boolean from public.companies c where c.id = p_doc.company_id), false);
  v_req public.approval_requests;
  v_tr public.document_transitions;
  v_reason text;
  v_account public.accounts;
  v_balance numeric;
  v_last public.documents;
  v_order public.documents;
  v_result jsonb := '[]';
begin
  select * into v_req from public.approval_requests a where a.document_id = p_doc.id and a.status = 'PENDIENTE';
  for v_tr in
    select * from public.document_transitions t
     where t.doc_type = p_doc.doc_type and t.from_status = p_doc.status and t.action <> 'SYSTEM'
     order by t.sort
  loop
    continue when v_tr.permission_code is null or not private.has_permission(p_doc.company_id, v_tr.permission_code);
    continue when v_result @> jsonb_build_array(jsonb_build_object('action', v_tr.action));
    v_reason := null;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action in ('APPROVE', 'REJECT') then
      if v_req.id is not null and not v_supervisor and not (v_req.approver_role = any (v_roles)) then
        v_reason := format('Por el monto (%s) la aprueba %s.', private.format_money(v_req.amount),
                           (select r.name from public.roles r where r.code = v_req.approver_role));
      elsif not v_supervisor and v_sod and p_doc.created_by = v_uid then
        v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden que creaste vos.';
      end if;
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'WITHDRAW' and not v_supervisor
       and p_doc.created_by is distinct from v_uid then
      v_reason := 'Sólo quien creó la orden puede retirarla.';
    end if;
    if p_doc.doc_type = 'PURCHASE_ORDER' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.purchase_order_lines l where l.document_id = p_doc.id and l.qty_received > 0) then
      v_reason := 'Tiene recepciones: usá "Cerrar saldo".';
    end if;
    if p_doc.doc_type = 'PURCHASE_REQUISITION' and v_tr.action in ('SUBMIT', 'CANCEL') and not v_supervisor
       and p_doc.created_by is distinct from v_uid
       and (p_doc.sector_id is null or not exists (
         select 1 from public.company_members m join public.member_roles mr on mr.member_id = m.id
          where m.company_id = p_doc.company_id and m.user_id = v_uid and mr.sector_id = p_doc.sector_id)) then
      v_reason := 'Sólo el sector solicitante puede hacerlo.';
    end if;
    if p_doc.doc_type = 'GOODS_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' and v_sod
       and not v_supervisor and not ('GERENCIA' = any (v_roles)) and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularla.';
    end if;
    if p_doc.doc_type = 'JOURNAL_ENTRY' and v_tr.action = 'CANCEL'
       and exists (select 1 from public.journal_entries je where je.document_id = p_doc.id and je.origin = 'CONTRAASIENTO') then
      v_reason := 'Un contraasiento no se anula. Si hubo un error, registrá el asiento correcto.';
    end if;
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action in ('APPROVE', 'REJECT') and not v_supervisor and v_sod
       and p_doc.created_by = v_uid then
      v_reason := 'Separación de funciones: no podés aprobar ni rechazar una orden de pago que preparaste vos.';
    end if;
    if p_doc.doc_type = 'PAYMENT_ORDER' and v_tr.action = 'PAY' and not v_supervisor and v_sod
       and exists (select 1 from public.payment_order_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: registraste una de las facturas; tiene que pagarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'RFQ' and v_tr.action = 'AWARD'
       and not exists (select 1 from private.rfq_quotes(p_doc.id) q where private.quote_is_valid(q.id)) then
      v_reason := 'Todavía no hay cotizaciones vigentes para adjudicar.';
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and v_tr.action = 'CONFIRM' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.from_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('No alcanza el saldo de %s %s: hay %s.', v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'FUNDS_TRANSFER' and p_doc.status = 'CONFIRMADA' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.funds_transfers t join public.accounts a on a.id = t.to_account_id
       where t.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Para devolverlos, prepará otra transferencia.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'BANK_RECONCILIATION' and v_tr.action = 'CANCEL' then
      v_last := private.last_reconciliation((select r.account_id from public.bank_reconciliations r where r.document_id = p_doc.id));
      if v_last.id is not null and v_last.id <> p_doc.id then
        v_reason := format('Sólo se anula la última conciliación de la cuenta (%s).', v_last.display_number);
      end if;
    end if;
    if p_doc.doc_type = 'SALES_ORDER' then
      v_reason := coalesce(private.sales_order_action_reason(p_doc, v_tr.action), v_reason);
    end if;
    if p_doc.doc_type = 'SALES_QUOTE' then
      if v_tr.action in ('SEND', 'CONFIRM') and private.sales_quote_expired(p_doc) then
        v_reason := format('La oferta venció el %s: prepará otro presupuesto con los precios del día.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
      if v_tr.action = 'CLOSE' and not private.sales_quote_expired(p_doc) then
        v_reason := format('Vale hasta el %s: todavía no venció.',
                           (select to_char(q.valid_until, 'DD/MM/YYYY') from public.sales_quotes q where q.document_id = p_doc.id));
      end if;
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and v_tr.action = 'CONFIRM' and not v_supervisor and v_sod
       and exists (select 1 from public.customer_receipt_lines l
                    where l.document_id = p_doc.id and private.invoice_registrant(l.invoice_id) = v_uid) then
      v_reason := 'Separación de funciones: emitiste una de las facturas; tiene que cobrarla otro integrante de Tesorería.';
    end if;
    if p_doc.doc_type = 'CUSTOMER_RECEIPT' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select a.* into v_account from public.customer_receipts x join public.accounts a on a.id = x.treasury_account_id
       where x.document_id = p_doc.id;
      v_balance := private.account_balance(v_account.id);
      if p_doc.total > v_balance + 0.000000001 then
        v_reason := format('Los fondos ya se usaron: en %s %s hay %s. Primero hay que anular el movimiento que los usó.',
                           v_account.code, v_account.name, private.format_money(v_balance));
      end if;
    end if;
    if p_doc.doc_type = 'DELIVERY_NOTE' and p_doc.status = 'CONFIRMADO' and v_tr.action = 'CANCEL' then
      select d.* into v_order from public.delivery_notes x join public.documents d on d.id = x.sales_order_id
       where x.document_id = p_doc.id;
      if v_sod and not v_supervisor and not ('GERENCIA' = any (v_roles)) and private.invoice_registrant(p_doc.id) = v_uid then
        v_reason := 'Separación de funciones: otro integrante de Depósito o Gerencia debe anularlo.';
      elsif v_order.status = 'CERRADO' then
        v_reason := format('%s está cerrado: ya no se anula el remito.', v_order.display_number);
      end if;
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'action', v_tr.action, 'label', v_tr.label, 'help', v_tr.help_text, 'tone', v_tr.tone,
      'requires_comment', v_tr.requires_comment, 'enabled', v_reason is null, 'reason', v_reason));
  end loop;
  return v_result;
end;
$$;
