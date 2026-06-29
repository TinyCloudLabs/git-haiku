import type { WeeklyReport } from '../api';

export function WeeklyReportCard({ report }: { report: WeeklyReport }) {
  return (
    <div className="card report-card">
      <div className="report-head">
        <div>
          <h3>Last week report</h3>
          <p className="muted">
            @{report.githubLogin} · {report.range.start} to {report.range.end} · {report.commitCount}{' '}
            commits
          </p>
        </div>
        <span className="report-agent">{report.generatedBy === 'redpill-agent' ? 'agent' : 'summary'}</span>
      </div>

      <section className="report-section">
        <h4>Overview</h4>
        <p>{report.overview}</p>
      </section>

      <section className="report-section">
        <h4>Day by day</h4>
        <div className="report-days">
          {report.days.map((day) => (
            <article key={day.date} className="report-day">
              <div className="report-day-head">
                <strong>
                  {day.weekday} · {day.date}
                </strong>
                <span className="muted">{day.commitCount} commits</span>
              </div>
              <p>{day.summary}</p>
              {day.highlights.length > 0 && (
                <ul>
                  {day.highlights.map((highlight, i) => (
                    <li key={`${day.date}-${i}`}>{highlight}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
