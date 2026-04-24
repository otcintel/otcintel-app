'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [search, setSearch] = useState('');

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    if (href === '/companies') return pathname === '/companies' || pathname.startsWith('/company/');
    if (href === '/simulator') return pathname === '/simulator';
    if (href === '/alerts') return pathname === '/alerts';
    return false;
  }

  function handleSearch(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && search.trim()) {
      router.push(`/company/${search.trim().toUpperCase()}`);
      setSearch('');
    }
  }

  return (
    <nav className="app-nav">
      <Link href="/" className="nav-logo">
        OTC<span>Intel</span>
      </Link>
      <div className="nav-links">
        <Link href="/dashboard"  className={`nav-link${isActive('/dashboard')  ? ' active' : ''}`}>Dashboard</Link>
        <Link href="/companies"  className={`nav-link${isActive('/companies')  ? ' active' : ''}`}>Companies</Link>
        <Link href="/simulator"  className={`nav-link${isActive('/simulator')  ? ' active' : ''}`}>Simulator</Link>
        <Link href="/alerts"     className={`nav-link${isActive('/alerts')     ? ' active' : ''}`}>Alerts</Link>
      </div>
      <div className="nav-right">
        <input
          className="nav-search"
          type="text"
          placeholder="Search ticker..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={handleSearch}
        />
      </div>
    </nav>
  );
}
