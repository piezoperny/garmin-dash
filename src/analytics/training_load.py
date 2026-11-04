"""
src/analytics/training_load.py

Continuous Training Load Engine implementing Banister Impulse-Response EWMA:
- Chronic Training Load (CTL): 42-day EWMA (time constant tau = 42)
- Acute Training Load (ATL): 7-day EWMA (time constant tau = 7)
- Training Stress Balance (TSB): TSB = CTL - ATL

Operates over a continuous daily timeline spanning min(activity_date) to max(activity_date),
decaying load on 0 TSS rest days, generating weekly volume/load rollups with week_start,
and tagging individual activities with their workout-day snapshot metrics.
"""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_INITIAL_ATL = 45.0
DEFAULT_INITIAL_CTL = 50.0


def parse_activity_date(act: Dict[str, Any]) -> Tuple[date, str]:
    """Extracts date object and ISO date string from an activity dictionary."""
    raw_str = act.get("start_time") or act.get("date") or ""
    if not raw_str:
        today = datetime.now(timezone.utc).date()
        return today, today.isoformat()
    clean_str = str(raw_str).replace(" ", "T")
    try:
        dt = datetime.fromisoformat(clean_str.replace("Z", "+00:00"))
        d = dt.date()
    except Exception:
        d = datetime.now(timezone.utc).date()
    return d, d.isoformat()


def calculate_continuous_training_load(
    activities: List[Dict[str, Any]],
    athlete_profile: Optional[Dict[str, Any]] = None,
    initial_atl: Optional[float] = None,
    initial_ctl: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Computes continuous daily EWMA curves (CTL 42d, ATL 7d, TSB = CTL - ATL).

    Returns:
        {
            "daily": List[Dict[str, Any]],               # Daily chronological timeline
            "weekly": List[Dict[str, Any]],              # Weekly aggregation rollups
            "activity_snapshots": Dict[str, Dict[str, float]], # Activity ID -> {atl, ctl, tsb}
        }
    """
    if not activities:
        return {
            "daily": [],
            "weekly": [],
            "activity_snapshots": {},
        }

    profile = athlete_profile or {}
    start_atl = float(
        initial_atl
        if initial_atl is not None
        else profile.get("initial_atl", profile.get("atl", DEFAULT_INITIAL_ATL))
    )
    start_ctl = float(
        initial_ctl
        if initial_ctl is not None
        else profile.get("initial_ctl", profile.get("ctl", DEFAULT_INITIAL_CTL))
    )

    # 1. Group activities by calendar date (YYYY-MM-DD)
    acts_by_date: Dict[date, List[Dict[str, Any]]] = defaultdict(list)
    for act in activities:
        d, _ = parse_activity_date(act)
        acts_by_date[d].append(act)

    sorted_dates = sorted(acts_by_date.keys())
    min_date = sorted_dates[0]
    max_date = sorted_dates[-1]

    # 2. Iterate continuous chronological calendar timeline from min_date to max_date
    atl = start_atl
    ctl = start_ctl

    daily_timeline: List[Dict[str, Any]] = []
    activity_snapshots: Dict[str, Dict[str, float]] = {}

    # Weekly aggregation tracking: key -> weekly metrics
    # Key: (iso_year, iso_week)
    weekly_agg: Dict[Tuple[int, int], Dict[str, Any]] = {}

    curr_date = min_date
    while curr_date <= max_date:
        d_str = curr_date.isoformat()
        day_acts = acts_by_date.get(curr_date, [])

        # Sum daily TSS across all activities on this day (0.0 for rest days)
        day_tss = sum(
            float(a.get("tss") or a.get("training_stress_score") or 0.0)
            for a in day_acts
        )

        # Banister EWMA daily update
        atl += (day_tss - atl) / 7.0
        ctl += (day_tss - ctl) / 42.0
        tsb = round(ctl - atl, 1)

        daily_record = {
            "date": d_str,
            "tss": round(day_tss, 1),
            "atl": round(atl, 1),
            "ctl": round(ctl, 1),
            "tsb": tsb,
        }
        daily_timeline.append(daily_record)

        # Assign date snapshot to each workout on this day
        for a in day_acts:
            act_id = str(a.get("id", ""))
            activity_snapshots[act_id] = {
                "atl": round(atl, 1),
                "ctl": round(ctl, 1),
                "tsb": tsb,
            }

        # Track weekly aggregation
        iso_year, iso_week, _ = curr_date.isocalendar()
        week_key = (iso_year, iso_week)
        week_label = f"{iso_year}-W{iso_week:02d}"

        # Week start is the Monday of this ISO week
        monday_date = curr_date - timedelta(days=curr_date.weekday())
        week_start_str = monday_date.isoformat()

        if week_key not in weekly_agg:
            weekly_agg[week_key] = {
                "week": week_label,
                "week_start": week_start_str,
                "running_hours": 0.0,
                "walking_hours": 0.0,
                "hiking_hours": 0.0,
                "cycling_hours": 0.0,
                "strength_hours": 0.0,
                "run_km": 0.0,
                "walk_km": 0.0,
                "hiking_km": 0.0,
                "cycle_km": 0.0,
                "load": 0.0,
                "atl": round(atl, 1),
                "ctl": round(ctl, 1),
                "tsb": tsb,
            }

        w_entry = weekly_agg[week_key]
        w_entry["load"] = round(w_entry["load"] + day_tss, 1)
        # Snapshot end-of-week / latest day in week
        w_entry["atl"] = round(atl, 1)
        w_entry["ctl"] = round(ctl, 1)
        w_entry["tsb"] = round(ctl - atl, 1)

        # Accumulate sport-specific distance and duration from day activities
        for a in day_acts:
            sport = str(a.get("sport", "other")).lower()
            dist_km = float(a.get("distance_meters", 0.0)) / 1000.0
            dur_hours = float(a.get("duration_seconds", 0.0)) / 3600.0

            if sport in ("running", "run"):
                w_entry["run_km"] = round(w_entry["run_km"] + dist_km, 1)
                w_entry["running_hours"] = round(w_entry["running_hours"] + dur_hours, 1)
            elif sport in ("walking", "walk"):
                w_entry["walk_km"] = round(w_entry["walk_km"] + dist_km, 1)
                w_entry["walking_hours"] = round(w_entry["walking_hours"] + dur_hours, 1)
            elif sport in ("hiking", "hike"):
                w_entry["hiking_km"] = round(w_entry["hiking_km"] + dist_km, 1)
                w_entry["hiking_hours"] = round(w_entry["hiking_hours"] + dur_hours, 1)
            elif sport in ("cycling", "cycle"):
                w_entry["cycle_km"] = round(w_entry["cycle_km"] + dist_km, 1)
                w_entry["cycling_hours"] = round(w_entry["cycling_hours"] + dur_hours, 1)
            elif sport in ("strength", "weights"):
                w_entry["strength_hours"] = round(w_entry["strength_hours"] + dur_hours, 1)

        curr_date += timedelta(days=1)

    weekly_list = [weekly_agg[k] for k in sorted(weekly_agg.keys())]

    return {
        "daily": daily_timeline,
        "weekly": weekly_list,
        "activity_snapshots": activity_snapshots,
    }
