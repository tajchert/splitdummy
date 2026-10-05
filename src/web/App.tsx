import { Suspense, type ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { ApiProvider } from "./api/context";
import type { Api } from "./api/types";
import { ToastProvider } from "./components/Toast";
import { Landing } from "./pages/Landing";
import { SignIn, CheckInbox } from "./pages/SignIn";
import { MyGroups } from "./pages/MyGroups";
import { GroupLayout } from "./pages/group/GroupLayout";
import { GroupHome } from "./pages/group/GroupHome";
import { EntryFormRoute } from "./pages/group/EntryForm";
import { EntryDetail } from "./pages/group/EntryDetail";
import { EntriesPage } from "./pages/group/EntriesPage";
import { NotFound } from "./pages/NotFound";
import { PageLoading, ScrollToTop } from "./components/Shell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { lazyPage } from "./lib/lazyPage";

// Less frequent screens load on demand.
const Account = lazyPage(() => import("./pages/Account"), "Account");
const ApiDocs = lazyPage(() => import("./pages/ApiDocs"), "ApiDocs");
const CreateGroup = lazyPage(() => import("./pages/CreateGroup"), "CreateGroup");
const Join = lazyPage(() => import("./pages/Join"), "Join");
const Invite = lazyPage(() => import("./pages/Invite"), "Invite");
const BalanceExplain = lazyPage(() => import("./pages/group/BalanceExplain"), "BalanceExplain");
const Review = lazyPage(() => import("./pages/group/Review"), "Review");
const History = lazyPage(() => import("./pages/group/History"), "History");
const RoundPage = lazyPage(() => import("./pages/group/RoundPage"), "RoundPage");
const Settings = lazyPage(() => import("./pages/group/Settings"), "Settings");
const Correction = lazyPage(() => import("./pages/group/Correction"), "Correction");
const AuthConfirm = lazyPage(() => import("./pages/AuthConfirm"), "AuthConfirm");

/** Notification emails link to /projects/:id; the app's group route is /g/:id. */
function ProjectRedirect() {
  const { projectId = "" } = useParams();
  return <Navigate to={`/g/${encodeURIComponent(projectId)}`} replace />;
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signin/sent" element={<CheckInbox />} />
        <Route path="/auth/confirm" element={<AuthConfirm />} />
        <Route path="/account" element={<Account />} />
        <Route path="/docs/api" element={<ApiDocs />} />
        <Route path="/groups" element={<MyGroups />} />
        <Route path="/groups/new" element={<CreateGroup />} />
        <Route path="/join" element={<Join />} />
        <Route path="/join/:token" element={<Join />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/projects/:projectId" element={<ProjectRedirect />} />
        <Route path="/g/:projectId" element={<GroupLayout />}>
          <Route element={<GroupHome />}>
            <Route index element={null} />
            <Route path="new" element={<EntryFormRoute type="EXPENSE" />} />
            <Route path="refund" element={<EntryFormRoute type="REFUND" />} />
            <Route path="e/:entryId" element={<EntryDetail />} />
            <Route path="e/:entryId/edit" element={<EntryFormRoute />} />
          </Route>
          <Route path="entries" element={<EntriesPage />}>
            <Route path=":entryId" element={<EntryDetail />} />
          </Route>
          <Route path="balance" element={<BalanceExplain />} />
          <Route path="review" element={<Review />} />
          <Route path="history" element={<History />} />
          <Route path="rounds/:roundId" element={<RoundPage />}>
            <Route path="e/:entryId" element={<EntryDetail />} />
          </Route>
          <Route path="correct/:roundId/:entryId" element={<Correction />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export function App({ api, devPanel: DevPanel }: { api: Api; devPanel?: ComponentType }) {
  return (
    <ApiProvider api={api}>
      <ToastProvider>
        <BrowserRouter>
          <ScrollToTop />
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
          {DevPanel && <DevPanel />}
        </BrowserRouter>
      </ToastProvider>
    </ApiProvider>
  );
}
