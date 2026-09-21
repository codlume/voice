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
createRoot(root).render(
  <RegistryProvider>
    <RouterProvider router={router} />
  </RegistryProvider>,
);
