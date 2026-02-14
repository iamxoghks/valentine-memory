import { Navigate, Outlet, useLocation } from 'react-router-dom';

type ProtectedRouteProps = {
  isAuthenticated: boolean;
  isLoading: boolean;
};

export function ProtectedRoute({ isAuthenticated, isLoading }: ProtectedRouteProps) {
  const location = useLocation();

  if (isLoading) {
    return <div className="p-6 text-center text-sm text-slate-500">불러오는 중...</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
