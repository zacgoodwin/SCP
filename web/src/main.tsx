import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthProvider, RequireAuth } from './auth.tsx';
import { Layout } from './components/Layout.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { ActivityPage } from './pages/Activity.tsx';
import { AdminUsersPage } from './pages/AdminUsers.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { GroupDetailPage } from './pages/GroupDetail.tsx';
import { GroupsPage } from './pages/Groups.tsx';
import { ItemDetailPage } from './pages/ItemDetail.tsx';
import { ItemsListPage } from './pages/ItemsList.tsx';
import { KeysPage } from './pages/Keys.tsx';
import { LoginPage } from './pages/Login.tsx';
import { NewItemPage } from './pages/NewItem.tsx';
import { NotFoundPage, RouteErrorPage } from './pages/NotFound.tsx';
import { RegisterPage } from './pages/Register.tsx';
import './styles.css';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteErrorPage /> },
  { path: '/register', element: <RegisterPage />, errorElement: <RouteErrorPage /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/skills', element: <ItemsListPage key="skill" plane="skill" /> },
      { path: '/mds', element: <ItemsListPage key="md" plane="md" /> },
      { path: '/artifacts', element: <ItemsListPage key="artifact" plane="artifact" /> },
      { path: '/items/new', element: <NewItemPage /> },
      { path: '/items/:id', element: <ItemDetailPage /> },
      { path: '/groups', element: <GroupsPage /> },
      { path: '/groups/:slug', element: <GroupDetailPage /> },
      { path: '/keys', element: <KeysPage /> },
      { path: '/activity', element: <ActivityPage /> },
      { path: '/admin/users', element: <AdminUsersPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);
