import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy · Retain" };

export default function Privacy() {
  return (
    <main style={{ maxWidth: 680 }}>
      <div className="stack">
        <p className="eyebrow"><a href="/">Retain</a></p>
        <h1>How Retain handles your data</h1>
        <p>Retain is for students aged 13 and older. Here is what we keep, why, and how to remove it.</p>
        <h2>What we save</h2>
        <ul>
          <li>Your email address, so you can sign in.</li>
          <li>Your first name, grade and classes, so the tutor can pitch explanations at your level.</li>
          <li>Your assignments and due dates.</li>
          <li>Your Notebook: the questions you ask the tutor, its answers, your lessons and quiz results, and the topics you have found hard.</li>
        </ul>
        <h2>Who can see it</h2>
        <p>Only you. Your data is stored in a database that only lets each account read its own rows. We do not sell your data or show you ads.</p>
        <h2>The AI tutor</h2>
        <p>When you ask the tutor something, your question (and any photo you attach) is sent to Anthropic&apos;s Claude API to write the answer. Photos are not stored by Retain.</p>
        <h2>Deleting your data</h2>
        <p>Open <b>Me</b> and choose <b>Delete my data</b>. That erases your classes, tasks and Notebook right away and signs you out.</p>
      </div>
    </main>
  );
}
