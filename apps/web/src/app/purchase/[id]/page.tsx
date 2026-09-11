import type { Metadata } from "next";
import { PurchaseView } from "./purchase-view";

export async function generateMetadata({ params }: PageProps<"/purchase/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Purchase #${id}` };
}

export default async function PurchasePage({ params }: PageProps<"/purchase/[id]">) {
  const { id } = await params;
  return <PurchaseView id={id} />;
}
