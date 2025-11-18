import { Outlet } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";

export default function Layout() {
    return (
        <SidebarProvider defaultOpen={false}>
            <AppSidebar variant="floating" />
            <SidebarInset className="min-h-screen">
                <SidebarTrigger className="fixed left-3 top-3 md:hidden z-5" />

                <div className="px-6 sm:px-12 py-24 grow">
                    <Outlet />
                </div>

                <footer className="text-sm w-full text-center border-t py-4">
                    © {new Date().getFullYear()} Nevò Mirzai Hamadani
                </footer>

                <Toaster />
            </SidebarInset>
        </SidebarProvider>
    );
}
