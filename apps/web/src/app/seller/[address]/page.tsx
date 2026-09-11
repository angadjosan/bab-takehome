import type { Metadata } from "next";
import { SellerView } from "./seller-view";

export async function generateMetadata({ params }: PageProps<"/seller/[address]">): Promise<Metadata> {
  const { address } = await params;
  return { title: `Account ${address.slice(0, 6)}…${address.slice(-4)}` };
}

export default async function SellerPage({ params }: PageProps<"/seller/[address]">) {
  const { address } = await params;
  return <SellerView address={address} />;
}
