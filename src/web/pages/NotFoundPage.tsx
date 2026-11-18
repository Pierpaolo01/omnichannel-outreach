import { Link } from "wouter";
import { PageTitle } from "../App.tsx";

export function NotFoundPage() {
  return (
    <div>
      <PageTitle>Page not found</PageTitle>
      <p className="mt-2 text-muted">
        There’s nothing at this address. <Link href="/" className="text-base-content underline">Go to Today</Link>.
      </p>
    </div>
  );
}
