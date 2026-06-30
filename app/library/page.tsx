import { Sidebar } from "@/components/Sidebar";
import { LibraryClient } from "@/components/LibraryClient";
import { UserAccountNav } from "@/components/UserAccountNav";
import { getMergedKnowledgeItems } from "@/lib/library-store";
import { KnowledgeType } from "@/types";
import { Suspense } from "react";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ type?: KnowledgeType }> }) {
  const params = await searchParams;
  const type = params.type;
  const knowledgeItems = await getMergedKnowledgeItems();
  const items = type ? knowledgeItems.filter((item) => item.type === type) : knowledgeItems;
  return (
    <main className="library-page-shell min-h-screen">
      <Suspense fallback={null}>
        <Sidebar />
      </Suspense>
      <div className="p-5 lg:pl-28 lg:pr-8 lg:py-8">
        <div className="mb-4 flex justify-end">
          <UserAccountNav />
        </div>
        <LibraryClient initialItems={items} type={type} />
      </div>
    </main>
  );
}
