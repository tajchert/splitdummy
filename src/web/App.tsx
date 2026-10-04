import type { ComponentType } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { ApiProvider } from "./api/context";
import type { Api } from "./api/types";
import { ToastProvider } from "./components/Toast";
import { ScrollToTop } from "./components/Shell";
import { Landing } from "./pages/Landing";
import { SignIn, CheckInbox } from "./pages/SignIn";
import { AuthConfirm } from "./pages/AuthConfirm";
import { Account } from "./pages/Account";
import { MyGroups } from "./pages/MyGroups";
import { CreateGroup } from "./pages/CreateGroup";
import { Join } from "./pages/Join";
import { GroupLayout } from "./pages/group/GroupLayout";
import { GroupHome } from "./pages/group/GroupHome";
import { EntryFormRoute } from "./pages/group/EntryForm";
import { EntryDetail } from "./pages/group/EntryDetail";
import { BalanceExplain } from "./pages/group/BalanceExplain";
import { Review } from "./pages/group/Review";
import { History } from "./pages/group/History";
import { RoundPage } from "./pages/group/RoundPage";
import { Settings } from "./pages/group/Settings";
import { Correction } from "./pages/group/Correction";
import { EntriesPage } from "./pages/group/EntriesPage";
import { NotFound } from "./pages/NotFound";

export function AppRoutes() {
  return (
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
