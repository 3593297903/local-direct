import { AdminLibraryClient } from "@/components/AdminLibraryClient";
import { Sidebar } from "@/components/Sidebar";
import { getMergedKnowledgeItems } from "@/lib/library-store";
import { Suspense } from "react";

export default async function AdminLibraryPage() {
  const items = await getMergedKnowledgeItems();
  return (
    <main className="min-h-screen">
      <Suspense fallback={null}>
        <Sidebar />
      </Suspense>
      <div className="p-5 lg:pl-28 lg:pr-8 lg:py-8">
        <AdminLibraryClient initialItems={items} />
      </div>
    </main>
  );
}
