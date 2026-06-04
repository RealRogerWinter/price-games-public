import { Routes, Route, Navigate } from "react-router-dom";
import { AdminAuthProvider, useAdminAuth } from "../../context/AdminAuthContext";
import AdminLoginPage from "./AdminLoginPage";
import AdminDashboard from "./AdminDashboard";
import AdminNav from "./AdminNav";
import AdminProductsPage from "./AdminProductsPage";
import AdminArchivedProductsPage from "./AdminArchivedProductsPage";
import AdminProductDetailPage from "./AdminProductDetailPage";
import AdminUsersPage from "./AdminUsersPage";
import AdminUserDetailPage from "./AdminUserDetailPage";
import AdminExtensionPage from "./AdminExtensionPage";
import AdminRewardsPage from "./AdminRewardsPage";
import AdminReferralsPage from "./AdminReferralsPage";
import AdminUtmTagsPage from "./AdminUtmTagsPage";
import AdminUtmTagDetailPage from "./AdminUtmTagDetailPage";
import AdminBannerPage from "./AdminBannerPage";
import AdminGameModesPage from "./AdminGameModesPage";
import AdminGhostUsersPage from "./AdminGhostUsersPage";
import AdminDailyModePage from "./AdminDailyModePage";
import AdminAvatarsPage from "./AdminAvatarsPage";
import AdminAssetGalleryPage from "./AdminAssetGalleryPage";
import AdminLeaderboardPage from "./AdminLeaderboardPage";
import AdminLegalPage from "./AdminLegalPage";
import AdminContentPage from "./AdminContentPage";
import AdminPagesPage from "./AdminPagesPage";
import AdminNotificationsPage from "./AdminNotificationsPage";
import AdminEmailPage from "./AdminEmailPage";
import Admin2faSettingsPage from "./Admin2faSettingsPage";
import AdminAnalytics from "./analytics/AdminAnalytics";
import "./admin.css";

/**
 * Wrapper that redirects unauthenticated users to the admin login page.
 * Also enforces mandatory 2FA: admins without 2FA enabled are redirected
 * to the security setup page.
 * @param allow2faSetup - If true, skips the 2FA enforcement redirect
 *   (used by the security/setup route itself to avoid infinite redirect).
 */
function ProtectedRoute({ children, allow2faSetup = false }: { children: React.ReactNode; allow2faSetup?: boolean }) {
  const { isAuthenticated, loading, needsTotpSetup } = useAdminAuth();

  if (loading) {
    return (
      <div className="admin-loading" data-testid="admin-auth-loading">
        <span className="admin-loading-spinner" />
        Checking session...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }

  // Enforce mandatory 2FA — redirect to setup if not enrolled
  if (needsTotpSetup && !allow2faSetup) {
    return <Navigate to="/admin/security" replace />;
  }

  return <>{children}</>;
}

/**
 * Wrapper that redirects authenticated users away from the login page
 * to the admin dashboard.
 */
function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAdminAuth();

  if (loading) {
    return (
      <div className="admin-loading" data-testid="admin-auth-loading">
        <span className="admin-loading-spinner" />
        Checking session...
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}

/**
 * Layout wrapper that includes the admin navigation bar.
 */
function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AdminNav />
      {children}
    </>
  );
}

/**
 * Admin sub-router. Wraps all admin routes in AdminAuthProvider and
 * provides login, dashboard, products, and redirect routes.
 */
function AdminRoutes() {
  return (
    <div className="admin-app" data-testid="admin-app">
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <AdminLoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminDashboard />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/products"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminProductsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/products/archived"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminArchivedProductsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/products/:id"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminProductDetailPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/users"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminUsersPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/users/:id"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminUserDetailPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/rewards"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminRewardsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/referrals"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminReferralsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/utm-tags"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminUtmTagsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/utm-tags/:id"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminUtmTagDetailPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/banner"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminBannerPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/game-modes"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminGameModesPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/ghost-users"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminGhostUsersPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/daily-mode"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminDailyModePage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/avatars"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminAvatarsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/gallery"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminAssetGalleryPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminLeaderboardPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/legal"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminLegalPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/content"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminContentPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/pages"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminPagesPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/extension"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminExtensionPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/notifications"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminNotificationsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/email"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminEmailPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/security"
          element={
            <ProtectedRoute allow2faSetup>
              <AdminLayout>
                <Admin2faSettingsPage />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/analytics/*"
          element={
            <ProtectedRoute>
              <AdminLayout>
                <AdminAnalytics />
              </AdminLayout>
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </div>
  );
}

/**
 * Top-level admin app component. Provides the AdminAuthProvider context
 * and renders the admin route tree.
 */
export default function AdminApp() {
  return (
    <AdminAuthProvider>
      <AdminRoutes />
    </AdminAuthProvider>
  );
}
