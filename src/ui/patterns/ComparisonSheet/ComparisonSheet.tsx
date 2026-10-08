import styles from "./ComparisonSheet.module.css";

export type ComparisonRow = { aspect: string; before: string; after: string };

type ComparisonSheetProps = { caption: string; beforeLabel: string; afterLabel: string; rows: ComparisonRow[] };

/** A spec sheet: one row per difference, hairlines between rows. */
export function ComparisonSheet({ caption, beforeLabel, afterLabel, rows }: ComparisonSheetProps) {
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Aspect</th>
            <th scope="col">{beforeLabel}</th>
            <th scope="col">{afterLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.aspect}>
              <th scope="row" className={styles.aspect}>
                {r.aspect}
              </th>
              <td className={styles.then}>{r.before}</td>
              <td>{r.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
