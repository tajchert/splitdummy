import { lazy, Suspense, type ComponentType } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
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

// Less frequent screens load on demand.
const Account = lazy(() => import("./pages/Account").then((m) => ({ default: m.Account })));
const CreateGroup = lazy(() => import("./pages/CreateGroup").then((m) => ({ default: m.CreateGroup })));
const Join = lazy(() => import("./pages/Join").then((m) => ({ default: m.Join })));
const BalanceExplain = lazy(() => import("./pages/group/BalanceExplain").then((m) => ({ default: m.BalanceExplain })));
const Review = lazy(() => import("./pages/group/Review").then((m) => ({ default: m.Review })));
const History = lazy(() => import("./pages/group/History").then((m) => ({ default: m.History })));
const RoundPage = lazy(() => import("./pages/group/RoundPage").then((m) => ({ default: m.RoundPage })));
const Settings = lazy(() => import("./pages/group/Settings").then((m) => ({ default: m.Settings })));
const Correction = lazy(() => import("./pages/group/Correction").then((m) => ({ default: m.Correction })));
const AuthConfirm = lazy(() => import("./pages/AuthConfirm").then((m) => ({ default: m.AuthConfirm })));

export function AppRoutes() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signin/sent" element={<CheckInbox />} />
        <Route path="/auth/confirm" element={<AuthConfirm />} />
        <Route path="/account" element={<Account />} />
        <Route path="/groups" element={<MyGroups />} />
        <Route path="/groups/new" element={<CreateGroup />} />
        <Route path="/join" element={<Join />} />
        <Route path="/join/:token" element={<Join />} />
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
          <AppRoutes />
          {DevPanel && <DevPanel />}
        </BrowserRouter>
      </ToastProvider>
    </ApiProvider>
  );
}
