import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ProjectsClient } from "@/components/ProjectsClient";
import { UserAccountNav } from "@/components/UserAccountNav";

export default function ProjectsPage() {
  return (
    <main className="min-h-screen">
      <Suspense fallback={null}>
        <Sidebar />
      </Suspense>
      <div className="p-5 lg:pl-28 lg:pr-8 lg:py-8">
        <div className="mb-4 flex justify-end">
          <UserAccountNav />
        </div>
        <ProjectsClient />
      </div>
    </main>
  );
}
