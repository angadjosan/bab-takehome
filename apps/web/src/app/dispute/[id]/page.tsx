import type { Metadata } from "next";
import { DisputeView } from "./dispute-view";

export async function generateMetadata({ params }: PageProps<"/dispute/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: `Dispute #${id}` };
}

export default async function DisputePage({ params }: PageProps<"/dispute/[id]">) {
  const { id } = await params;
  return <DisputeView id={id} />;
}
