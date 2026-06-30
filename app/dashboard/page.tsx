import { Sidebar } from "@/components/Sidebar";
import { DashboardClient } from "@/components/DashboardClient";
import { UserAccountNav } from "@/components/UserAccountNav";
import { Suspense } from "react";

export default function DashboardPage() {
  return (
    <main className="min-h-screen">
      <Suspense fallback={null}>
        <Sidebar />
      </Suspense>
      <div className="p-5 lg:pl-28 lg:pr-8 lg:py-8">
        <div className="mb-4 flex justify-end">
          <UserAccountNav />
        </div>
        <DashboardClient />
      </div>
    </main>
  );
}
