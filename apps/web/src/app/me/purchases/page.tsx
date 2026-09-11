import type { Metadata } from "next";
import { MyPurchasesView } from "./view";

export const metadata: Metadata = { title: "My purchases" };

export default function MyPurchasesPage() {
  return <MyPurchasesView />;
}
