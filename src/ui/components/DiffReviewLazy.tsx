import { lazy, Suspense } from "react";
import type { DiffReviewProps } from "./DiffReview.js";
import { Skeleton } from "./ui.js";

// The review screen, its patch parsing and syntax colours load the first time a diff is shown, not
// with the app.
const Review = lazy(() => import("./DiffReview.js").then((module) => ({ default: module.DiffReview })));

export function DiffReview(props: DiffReviewProps) {
  return (
    <Suspense fallback={<Skeleton rows={4} />}>
      <Review {...props} />
    </Suspense>
  );
}
