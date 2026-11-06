'use client';
import { useParams } from 'next/navigation';
import { BatchForm } from '@/components/purchases/batch-form';

export default function EditPaymentBatchPage() {
  const { batchId } = useParams<{ batchId: string }>();
  return <BatchForm batchId={batchId} />;
}
