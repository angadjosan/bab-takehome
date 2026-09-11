import type { Metadata } from "next";
import { ListingView } from "./listing-view";

export async function generateMetadata({ params }: PageProps<"/listing/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Environment #${id}` };
}

export default async function ListingPage({ params }: PageProps<"/listing/[id]">) {
  const { id } = await params;
  return <ListingView id={id} />;
}
