"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Laugh, Quote, Brain } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import type { TriviaQ } from "./types";
import { api } from "./api";

type Tab = "trivia" | "joke" | "quote";

export function FunView() {
  const [tab, setTab] = useState<Tab>("trivia");
  const [questions, setQuestions] = useState<TriviaQ[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [score, setScore] = useState<number | null>(null);
  const [joke, setJoke] = useState<{ setup: string; delivery: string; type: string } | null>(null);
  const [quote, setQuote] = useState<{ quote: string; author: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadTrivia = async () => {
    setLoading(true); setScore(null); setAnswers({});
    try {
      const qs = await api.fun<TriviaQ[]>("mode=trivia&amount=6");
      setQuestions(qs);
    } catch {
      toast({ title: "Eroare", description: "Nu am putut încărca trivia.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const loadJoke = async () => {
    setLoading(true);
    try {
      const j = await api.fun<{ setup: string; delivery: string; type: string }>("mode=joke");
      setJoke(j);
    } catch {
      toast({ title: "Eroare", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const loadQuote = async () => {
    setLoading(true);
    try {
      const q = await api.fun<{ quote: string; author: string }>("mode=quote");
      setQuote(q);
    } catch {
      toast({ title: "Eroare", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "trivia") loadTrivia();
    else if (tab === "joke") loadJoke();
    else loadQuote();
  }, [tab]);

  const verify = () => {
    let s = 0;
    questions.forEach((q, i) => { if (answers[i] === q.correct) s++; });
    setScore(s);
  };

  return (
    <div className="px-4 sm:px-6 py-6">
      <h1 className="mb-4 text-2xl font-black tracking-tight">🎪 Distracție & Divertisment</h1>

      <div className="mb-6 flex gap-2">
        {([
          { k: "trivia", l: "🧠 Quiz", icon: Brain },
          { k: "joke", l: "😂 Glume", icon: Laugh },
          { k: "quote", l: "💬 Citate", icon: Quote },
        ] as { k: Tab; l: string; icon: typeof Brain }[]).map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === t.k ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            <t.icon className="h-3.5 w-3.5" /> {t.l}
          </button>
        ))}
      </div>

      {tab === "trivia" && (
        <div className="mx-auto max-w-2xl space-y-4">
          {loading && <p className="text-center text-sm text-zinc-500">Se încarcă întrebările...</p>}
          {questions.map((q, i) => (
            <div key={i} className="rounded-xl bg-zinc-900 p-5 ring-1 ring-zinc-800">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-red-400">{q.category} • {q.difficulty}</p>
              <p className="mb-3 text-sm font-bold">{q.question}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {q.answers.map((a) => {
                  const selected = answers[i] === a;
                  const showCorrect = score !== null && a === q.correct;
                  const showWrong = score !== null && selected && a !== q.correct;
                  return (
                    <button
                      key={a}
                      onClick={() => score === null && setAnswers((s) => ({ ...s, [i]: a }))}
                      className={`rounded-lg px-3 py-2 text-left text-xs font-medium transition ring-1 ${
                        showCorrect ? "bg-emerald-950 text-emerald-300 ring-emerald-700"
                        : showWrong ? "bg-red-950 text-red-300 ring-red-700"
                        : selected ? "bg-zinc-800 text-white ring-zinc-600"
                        : "bg-zinc-950 text-zinc-300 ring-zinc-800 hover:ring-zinc-600"
                      }`}
                    >
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {questions.length > 0 && score === null && (
            <div className="flex justify-center gap-3">
              <Button onClick={verify} className="bg-red-600 hover:bg-red-500 text-white">Verifică răspunsurile</Button>
              <Button variant="outline" onClick={loadTrivia} className="border-zinc-700 text-zinc-200">
                <RefreshCw className="h-4 w-4 mr-1" /> Alte întrebări
              </Button>
            </div>
          )}
          {score !== null && (
            <div className="rounded-xl bg-gradient-to-r from-red-950 to-zinc-900 p-5 text-center ring-1 ring-red-800">
              <p className="text-2xl font-black">{score}/{questions.length} corecte 🎉</p>
              <Button onClick={loadTrivia} className="mt-3 bg-red-600 hover:bg-red-500 text-white">
                Joacă din nou
              </Button>
            </div>
          )}
        </div>
      )}

      {tab === "joke" && joke && (
        <div className="mx-auto max-w-xl rounded-2xl bg-zinc-900 p-8 text-center ring-1 ring-zinc-800">
          <p className="text-lg font-bold">{joke.setup}</p>
          {joke.delivery && <p className="mt-4 text-lg text-red-400 font-bold">{joke.delivery}</p>}
          <Button onClick={loadJoke} className="mt-6 bg-red-600 hover:bg-red-500 text-white">
            <RefreshCw className="h-4 w-4 mr-1" /> O glumă nouă
          </Button>
        </div>
      )}

      {tab === "quote" && quote && (
        <div className="mx-auto max-w-xl rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-950 p-8 text-center ring-1 ring-zinc-800">
          <p className="text-xl italic leading-relaxed text-zinc-100">„{quote.quote}"</p>
          <p className="mt-4 text-sm font-bold text-red-400">— {quote.author}</p>
          <Button onClick={loadQuote} className="mt-6 bg-red-600 hover:bg-red-500 text-white">
            <RefreshCw className="h-4 w-4 mr-1" /> Alt citat
          </Button>
        </div>
      )}
    </div>
  );
}
