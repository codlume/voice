import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { RegistryProvider } from "@effect/atom-react";
import { SettingsView } from "./settings";
import { StatusView } from "./status";
import "./style.css";

const rootRoute = createRootRoute({ component: Outlet });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: SettingsView,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([settingsRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
// The status panel window loads the same bundle with a view query instead of a route.
const view = new URLSearchParams(window.location.search).get("view");
createRoot(root).render(
  view === "status" ? (
    <StatusView />
  ) : (
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  ),
);
