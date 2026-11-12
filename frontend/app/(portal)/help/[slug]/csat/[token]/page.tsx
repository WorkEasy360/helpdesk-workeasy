'use client';

import { use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { csatSurveyService } from '@/services/analytics.service';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * The customer's side of a satisfaction survey. There is no sign-in — the emailed token
 * is the only credential — so a rating link in the email (?rating=N) can pre-select the
 * score and this screen only needs a confirm, while someone opening the plain link
 * picks a score here.
 */
export default function CsatSurveyPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { token } = use(params);
  const searchParams = useSearchParams();
  const presetRating = Number(searchParams.get('rating'));

  const survey = useQuery({
    queryKey: ['csat-survey', token],
    queryFn: () => csatSurveyService.load(token),
  });

  const [rating, setRating] = useState<number | null>(
    RATINGS.includes(presetRating as (typeof RATINGS)[number]) ? presetRating : null,
  );
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (RATINGS.includes(presetRating as (typeof RATINGS)[number])) setRating(presetRating);
  }, [presetRating]);

  const submit = useMutation({
    mutationFn: () => csatSurveyService.submit(token, { rating: rating!, comment: comment.trim() || undefined }),
  });

  if (survey.isPending) return <LoadingState label="Loading your survey…" />;
  if (survey.isError) {
    const message =
      survey.error instanceof ApiError ? survey.error.message : 'Unable to load this survey.';
    return (
      <div className="mx-auto max-w-lg py-10">
        <ErrorState message={message} />
      </div>
    );
  }

  if (submit.isSuccess) {
    return (
      <div className="mx-auto max-w-lg py-10">
        <Card>
          <CardHeader>
            <CardTitle>Thank you</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-muted-foreground">{submit.data.thankYouText}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = survey.data;

  return (
    <div className="mx-auto max-w-lg py-10">
      <Card>
        <CardHeader>
          <CardTitle>How did we do?</CardTitle>
          <CardDescription>
            About ticket #{data.ticketNumber} — {data.subject}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-base text-muted-foreground">{data.introText}</p>

          <div role="radiogroup" aria-label="Rating" className="flex items-center gap-2">
            {RATINGS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={rating === value}
                onClick={() => setRating(value)}
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full border transition-colors',
                  rating !== null && value <= rating
                    ? 'border-rating bg-warning-soft text-rating'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
                aria-label={`${value} star${value === 1 ? '' : 's'}`}
              >
                <Star className="h-5 w-5" fill={rating !== null && value <= rating ? 'currentColor' : 'none'} />
              </button>
            ))}
          </div>

          <label htmlFor="csat-comment" className="block text-base font-medium">
            Anything you would like us to know? (optional)
          </label>
          <Textarea
            id="csat-comment"
            rows={4}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Tell us more…"
          />

          {submit.isError ? (
            <p role="alert" className="text-base text-destructive">
              {submit.error instanceof ApiError ? submit.error.message : 'Unable to submit your rating.'}
            </p>
          ) : null}

          <Button
            type="button"
            disabled={rating === null}
            loading={submit.isPending}
            onClick={() => submit.mutate()}
          >
            Submit rating
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
