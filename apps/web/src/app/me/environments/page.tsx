import type { Metadata } from "next";
import { MyEnvironmentsView } from "./view";

export const metadata: Metadata = { title: "My environments" };

export default function MyEnvironmentsPage() {
  return <MyEnvironmentsView />;
}
