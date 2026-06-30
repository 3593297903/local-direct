-- AI Video Director SaaS database schema
-- Run this in Supabase SQL Editor.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'free',
  daily_limit integer not null default 3,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  original_script text not null,
  optimized_script text,
  content_type text,
  style text,
  duration text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.storyboard_shots (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  shot_number integer not null,
  scene text,
  visual text,
  shot_type text,
  camera_movement text,
  emotion text,
  transition text,
  first_frame_prompt text,
  video_prompt text,
  last_frame_prompt text,
  negative_prompt text,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_items (
  id uuid primary key default uuid_generate_v4(),
  type text not null check (type in ('transition','shot','camera_movement','style','storyboard_formula')),
  category text not null,
  name text not null,
  description text not null,
  prompt text not null,
  tags text[] not null default '{}',
  stability integer not null default 80,
  use_case text,
  avoid text,
  preview_url text,
  preview_type text,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_assets (
  id uuid primary key default uuid_generate_v4(),
  knowledge_item_id uuid references public.knowledge_items(id) on delete cascade,
  asset_type text not null check (asset_type in ('image','gif','video','thumbnail')),
  url text not null,
  storage_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.favorites (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  knowledge_item_id uuid references public.knowledge_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(user_id, knowledge_item_id)
);

create table if not exists public.usage_events (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  provider text,
  model text,
  input_chars integer default 0,
  output_chars integer default 0,
  cost_estimate numeric default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.storyboard_shots enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.media_assets enable row level security;
alter table public.favorites enable row level security;
alter table public.usage_events enable row level security;

-- Profiles
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- Projects
create policy "projects_select_own" on public.projects for select using (auth.uid() = user_id);
create policy "projects_insert_own" on public.projects for insert with check (auth.uid() = user_id);
create policy "projects_update_own" on public.projects for update using (auth.uid() = user_id);
create policy "projects_delete_own" on public.projects for delete using (auth.uid() = user_id);

-- Storyboard shots inherit access via project ownership
create policy "shots_select_own" on public.storyboard_shots for select using (
  exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
);
create policy "shots_insert_own" on public.storyboard_shots for insert with check (
  exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
);
create policy "shots_update_own" on public.storyboard_shots for update using (
  exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
);
create policy "shots_delete_own" on public.storyboard_shots for delete using (
  exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
);

-- Public read-only knowledge library
create policy "knowledge_public_read" on public.knowledge_items for select using (true);
create policy "media_public_read" on public.media_assets for select using (true);

-- Favorites
create policy "favorites_select_own" on public.favorites for select using (auth.uid() = user_id);
create policy "favorites_insert_own" on public.favorites for insert with check (auth.uid() = user_id);
create policy "favorites_delete_own" on public.favorites for delete using (auth.uid() = user_id);

-- Usage events
create policy "usage_select_own" on public.usage_events for select using (auth.uid() = user_id);
create policy "usage_insert_own" on public.usage_events for insert with check (auth.uid() = user_id);

-- Auto profile creation
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Vector search helper. Replace 1536 if your embedding model uses another dimension.
create or replace function public.match_knowledge_items(
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  name text,
  description text,
  prompt text,
  tags text[],
  similarity float
)
language sql stable
as $$
  select
    knowledge_items.id,
    knowledge_items.name,
    knowledge_items.description,
    knowledge_items.prompt,
    knowledge_items.tags,
    1 - (knowledge_items.embedding <=> query_embedding) as similarity
  from public.knowledge_items
  where 1 - (knowledge_items.embedding <=> query_embedding) > match_threshold
  order by knowledge_items.embedding <=> query_embedding
  limit match_count;
$$;
