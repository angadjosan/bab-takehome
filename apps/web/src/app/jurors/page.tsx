import type { Metadata } from "next";
import { JurorsView } from "./jurors-view";

export const metadata: Metadata = { title: "Jurors" };

export default function JurorsPage() {
  return <JurorsView />;
}
