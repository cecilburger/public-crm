import { redirect } from 'next/navigation';

// The Client menu is now two filtered views (Client Deal, Client On Proses),
// not one flat list — this bare path only exists so an old link or bookmark
// still lands somewhere real instead of a 404.
export default function ClientPage() {
  redirect('/client/proses');
}
