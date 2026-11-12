'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { FolderTree, MessageSquare } from 'lucide-react';
import { MODERATION_STATUSES, TOPIC_STATUSES, TOPIC_TYPES } from '@digisoft/shared';
import { ApiError } from '@/lib/api-client';
import { communityService } from '@/services/community.service';
import { formatDateTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/states';
import { Pagination } from '@/components/ui/pagination';
import { PageHeader } from '@/components/layout/page-header';
import { CommunityCategoryManager } from '@/components/community/category-manager';

const MODERATION_VARIANT: Record<string, 'success' | 'warning' | 'danger'> = {
  PUBLISHED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};

export default function CommunityPage() {
  const [page, setPage] = useState(1);
  const [moderation, setModeration] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  const topics = useQuery({
    queryKey: ['community-topics', { page, moderation, status, type, q }],
    queryFn: () =>
      communityService.topics({
        page,
        pageSize: 20,
        ...(moderation ? { moderation: moderation as 'PENDING' } : {}),
        ...(status ? { status: status as 'OPEN' } : {}),
        ...(type ? { type: type as 'QUESTION' } : {}),
        ...(q ? { q } : {}),
      }),
  });

  return (
    <>
      <PageHeader
        title="Community"
        description="Questions, ideas and discussions your customers post in the help center."
        actions={
          <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
            <FolderTree className="h-4 w-4" aria-hidden />
            Categories
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Input
          className="w-full sm:w-64"
          placeholder="Search topics…"
          value={q}
          aria-label="Search topics"
          onChange={(event) => {
            setPage(1);
            setQ(event.target.value);
          }}
        />
        <Select
          className="w-full sm:w-44"
          value={moderation}
          aria-label="Filter by moderation"
          onChange={(event) => {
            setPage(1);
            setModeration(event.target.value);
          }}
        >
          <option value="">Any moderation</option>
          {MODERATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
        <Select
          className="w-full sm:w-40"
          value={status}
          aria-label="Filter by status"
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value);
          }}
        >
          <option value="">Any status</option>
          {TOPIC_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
        <Select
          className="w-full sm:w-40"
          value={type}
          aria-label="Filter by type"
          onChange={(event) => {
            setPage(1);
            setType(event.target.value);
          }}
        >
          <option value="">Any type</option>
          {TOPIC_TYPES.map((value) => (
            <option key={value} value={value}>
              {value.charAt(0) + value.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {topics.isPending ? (
          <TableSkeleton columns={5} />
        ) : topics.isError ? (
          <ErrorState
            message={topics.error instanceof ApiError ? topics.error.message : 'Unable to load topics.'}
            onRetry={() => topics.refetch()}
          />
        ) : topics.data.items.length === 0 ? (
          <EmptyState
            title="Nothing posted yet"
            description="When customers start a discussion in the help center it lands here for moderation."
          />
        ) : (
          <>
            <DataTable>
              <THead>
                <TR>
                  <TH>Topic</TH>
                  <TH>Category</TH>
                  <TH>Author</TH>
                  <TH>Moderation</TH>
                  <TH className="text-right">Replies</TH>
                  <TH>Last activity</TH>
                </TR>
              </THead>
              <TBody>
                {topics.data.items.map((topic) => (
                  <TR key={topic.id}>
                    <TD>
                      <Link className="font-medium hover:underline" href={`/community/${topic.id}`}>
                        {topic.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {topic.type.charAt(0) + topic.type.slice(1).toLowerCase()}
                        {topic.isPinned ? ' · Pinned' : ''}
                        {topic.isLocked ? ' · Locked' : ''}
                        {topic.status === 'ANSWERED' ? ' · Answered' : ''}
                      </p>
                    </TD>
                    <TD className="text-base text-muted-foreground">{topic.category.name}</TD>
                    <TD className="text-base text-muted-foreground">
                      {topic.author ? `${topic.author.firstName} ${topic.author.lastName}` : 'Deleted user'}
                    </TD>
                    <TD>
                      <Badge variant={MODERATION_VARIANT[topic.moderation]}>
                        {topic.moderation.charAt(0) + topic.moderation.slice(1).toLowerCase()}
                      </Badge>
                    </TD>
                    <TD className="text-right text-base">
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                        {topic.replyCount}
                      </span>
                    </TD>
                    <TD className="text-base text-muted-foreground">{formatDateTime(topic.lastActivityAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </DataTable>
            <Pagination meta={topics.data.meta} onPageChange={setPage} />
          </>
        )}
      </Card>

      <CommunityCategoryManager open={categoriesOpen} onOpenChange={setCategoriesOpen} />
    </>
  );
}
