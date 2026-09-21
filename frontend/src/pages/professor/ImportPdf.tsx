import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileUp, AlertTriangle, FileText, CheckCircle2, Loader2, XCircle, RefreshCw, Trash2 } from 'lucide-react';
import { api, apiError } from '../../services/api';
import { ImportJob, Question } from '../../types';
import { PageHeader, Card, Button, Spinner, Badge, ConfirmDialog } from '../../components/ui';
import { QuestionView } from '../../components/QuestionView';

const jobStatusLabel: Record<ImportJob['status'], string> = {
  processing: 'Processando',
  completed: 'Concluída',
  failed: 'Falhou',
};

const jobStatusTone: Record<ImportJob['status'], 'amber' | 'green' | 'red'> = {
  processing: 'amber',
  completed: 'green',
  failed: 'red',
};

function JobStatusIcon({ status }: { status: ImportJob['status'] }) {
  if (status === 'processing') return <Loader2 size={18} className="text-amber-400 animate-spin" />;
  if (status === 'failed') return <XCircle size={18} className="text-red-400" />;
  return <CheckCircle2 size={18} className="text-emerald-400" />;
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ImportPdf() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ questions: Question[]; warnImages?: string } | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<Question | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Descartar aqui mesmo o que a extração trouxe errado (questão duplicada,
  // pedaço de outra prova): sem isso o professor só conseguia apagar depois,
  // caçando a questão na fila de revisão.
  const removeQuestion = async () => {
    const alvo = confirmDelete;
    if (!alvo) return;
    setConfirmDelete(null);
    setError('');
    setDeletingId(alvo.id);
    try {
      await api.delete(`/questions/${alvo.id}`);
      setResult((current) =>
        current ? { ...current, questions: current.questions.filter((q) => q.id !== alvo.id) } : current
      );
    } catch (err) {
      setError(apiError(err));
    } finally {
      setDeletingId(null);
    }
  };

  // B09: o status do job de importação precisa ficar visível, inclusive
  // depois de recarregar a página.
  const loadJobs = () => {
    setJobsLoading(true);
    api
      .get('/imports')
      .then(({ data }) => setJobs(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setJobsLoading(false));
  };

  useEffect(loadJobs, []);

  const sendFile = (file: File) => {
    if (!file) return;
    const isPdf = /\.pdf$/i.test(file.name);
    const isImage = /\.(png|jpe?g|webp)$/i.test(file.name);
    if (!isPdf && !isImage) {
      setError('Apenas arquivos PDF ou Imagens (PNG, JPG, WebP) são aceitos.');
      return;
    }
    setError('');
    setFileName(file.name);
    setProcessing(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    api
      .post('/imports/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then((res) => {
        setResult({ questions: res.data.questions ?? [], warnImages: res.data.warnImages });
      })
      .catch((err) => setError(apiError(err)))
      .finally(() => {
        setProcessing(false);
        loadJobs();
      });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) sendFile(file);
  };

  const onSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) sendFile(file);
  };

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader
        title="Importar Questões (PDF ou Imagem)"
        subtitle="A IA extrai as questões, preserva os elementos visuais e sugere a classificação. Você revisa e aprova."
      />

      {error && <div className="mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm px-4 py-3">{error}</div>}

      {!processing && !result && (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`cursor-pointer rounded-2xl border-2 border-dashed p-14 text-center transition ${
            dragging
              ? 'border-primary-400 bg-primary-500/10'
              : 'border-[color:var(--border)] bg-[color:var(--bg-card)] hover:border-primary-500/40'
          }`}
        >
          <div className="mx-auto mb-4 p-4 rounded-2xl bg-primary-500/10 border border-primary-500/20 w-fit">
            <FileUp size={40} className="text-primary-400" />
          </div>
          <p className="font-bold text-slate-100 mb-1">Arraste um PDF ou Imagem de questões aqui</p>
          <p className="text-sm text-slate-400 mb-4">PDF, PNG, JPG ou WebP (máx. 4 MB)</p>
          <input ref={inputRef} type="file" accept=".pdf,application/pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={onSelect} />
        </div>
      )}

      {processing && (
        <Card className="text-center py-12">
          <Spinner label={`Extraindo questões de "${fileName}"...`} />
          <p className="text-xs text-slate-500 mt-2">Separando questões, lendo gabarito e classificando com IA.</p>
        </Card>
      )}

      {result && (
        <div className="animate-fade-in">
          <div className="mb-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-5 flex items-start gap-4">
            <CheckCircle2 size={20} className="text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-bold text-emerald-300">{result.questions.length} questão(is) extraída(s) de "{fileName}"</p>
              <p className="text-sm text-slate-300 mt-1">As questões válidas foram para a fila de revisão.</p>
            </div>
          </div>

          {result.warnImages && (
            <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-5 flex items-start gap-4">
              <AlertTriangle size={20} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-slate-300">{result.warnImages}</p>
            </div>
          )}

          <div className="space-y-4 mb-6">
            {result.questions.map((q) => (
              <Card key={q.id} className="!p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {q.number && <Badge tone="neutral">Questão {q.number}</Badge>}
                    {q.gabarito && <Badge tone="teal">Gabarito: {q.gabarito.toUpperCase()}</Badge>}
                    {q.classificationSource === 'ai' && <Badge tone="blue">IA</Badge>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setConfirmDelete(q)}
                      disabled={deletingId === q.id}
                      className="p-1.5 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                      title="Excluir esta questão"
                    >
                      <Trash2 size={16} />
                    </button>
                    <Link to={`/professor/questoes/${q.id}/revisar`} className="text-sm font-semibold text-primary-300 hover:text-primary-200">
                      Revisar →
                    </Link>
                  </div>
                </div>
                <QuestionView question={q} compact />
              </Card>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={() => { setResult(null); setFileName(''); }} variant="outline">
              <FileText size={16} /> Importar outro PDF
            </Button>
            <Link to="/professor/questoes" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-primary-500 hover:bg-primary-400 shadow-lg shadow-primary-500/20">
              Ir para a fila de revisão →
            </Link>
          </div>
        </div>
      )}

      <section className="mt-10">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="font-bold text-slate-100">Importações recentes</h2>
            <p className="text-sm text-slate-400 mt-0.5">Acompanhe o status de cada arquivo enviado.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={loadJobs} disabled={jobsLoading}>
            <RefreshCw size={15} /> Atualizar
          </Button>
        </div>

        {jobsLoading && jobs.length === 0 ? (
          <Spinner label="Carregando importações..." />
        ) : jobs.length === 0 ? (
          <Card className="!p-5">
            <p className="text-sm text-slate-400">Nenhuma importação registrada ainda. Envie um PDF para começar.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <Card key={job.id} className="!p-4">
                <div className="flex items-start gap-4">
                  <div className="p-2.5 rounded-xl bg-slate-500/10 border border-[color:var(--border)] shrink-0">
                    <JobStatusIcon status={job.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <Badge tone={jobStatusTone[job.status]}>{jobStatusLabel[job.status]}</Badge>
                      <Badge tone="neutral">{job.totalQuestions ?? 0} questão(is) extraída(s)</Badge>
                    </div>
                    <p className="text-sm font-semibold text-slate-200 truncate" title={job.fileName}>
                      {job.fileName}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{formatDate(job.createdAt)}</p>
                    {job.status === 'failed' && job.errorMessage && (
                      <p className="mt-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs px-3 py-2">
                        {job.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={removeQuestion}
        title="Excluir questão"
        message={
          confirmDelete
            ? `Esta ação não pode ser desfeita. ${
                confirmDelete.number ? `A questão ${confirmDelete.number}` : 'A questão'
              } será removida permanentemente desta importação.`
            : ''
        }
        confirmLabel="Excluir"
        danger
      />
    </div>
  );
}