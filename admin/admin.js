const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

async function machineByCompanyId(req, res) {
    const { company_id, start_date, end_date } = req.params;

    const query = `
        WITH month_data AS (
            SELECT 
                dd.deviceuid AS machine_id,
                EXTRACT(YEAR FROM dd.timestamp) AS year,
                EXTRACT(MONTH FROM dd.timestamp) AS month,
                MAX((dd.data->>'This Month Production')::NUMERIC) AS max_prod,
                MIN((dd.data->>'This Month Production')::NUMERIC) AS min_prod
            FROM oee.device_data dd
            WHERE dd.timestamp >= TO_TIMESTAMP($2, 'YYYY-MM-DD HH24:MI:SS')
            AND dd.timestamp <= TO_TIMESTAMP($3, 'YYYY-MM-DD HH24:MI:SS')
            GROUP BY dd.deviceuid, EXTRACT(YEAR FROM dd.timestamp), EXTRACT(MONTH FROM dd.timestamp)
        ),
        
        reel_transitions AS (
            SELECT 
                dd.deviceuid AS machine_id,
                COUNT(*) AS produced_reels
            FROM oee.device_data dd
            JOIN (
                SELECT 
                    deviceuid,
                    LAG(dd.data->>'P_DT_BOBIN_FORMER_CHANGE') OVER (PARTITION BY dd.deviceuid ORDER BY dd.timestamp) AS prev_value,
                    dd.data->>'P_DT_BOBIN_FORMER_CHANGE' AS current_value
                FROM oee.device_data dd
                WHERE dd.timestamp >= TO_TIMESTAMP($2, 'YYYY-MM-DD HH24:MI:SS')
                AND dd.timestamp <= TO_TIMESTAMP($3, 'YYYY-MM-DD HH24:MI:SS')
                AND dd.data->>'P_DT_BOBIN_FORMER_CHANGE' IS NOT NULL
            ) AS transitions
            ON dd.deviceuid = transitions.deviceuid
            WHERE transitions.prev_value = '0' AND transitions.current_value = '1'
            GROUP BY dd.deviceuid
        )

        SELECT 
            m.machine_uid,
            m.machine_id,
            m.machine_name,
            m.machine_plant,
            m.machine_model,
            m.machine_customer,
            m.machine_location,
            m.machine_longitude,
            m.machine_latitude,
            mt.machine_type_name,
            m.company_id,
            
            COALESCE(
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'machine_part_id', p.machine_part_id,
                        'machine_part_name', p.machine_part_name,
                        'machine_part_serial_no', p.machine_part_serial_no,
                        'machine_image_path', p.machine_image_path,
                        'machine_image_name', p.machine_image_name
                    )
                ) FILTER (WHERE p.machine_part_id IS NOT NULL),
                '[]'
            ) AS model_data,
            
            COALESCE(
                (
                    SELECT 
                        CASE
                            WHEN dd.deviceuid IS NULL THEN 2
                            WHEN dd.data->>'MC_STATUS' IS NOT NULL THEN 
                                CASE
                                    WHEN dd.data->>'MC_STATUS' = '0' THEN 0
                                    WHEN dd.data->>'MC_STATUS' = '1' AND (dd.data->>'Act Speed')::NUMERIC = 0 THEN 3
                                    WHEN dd.data->>'MC_STATUS' = '1' AND (dd.data->>'Act Speed')::NUMERIC < 0.5 * (dd.data->>'Target Speed')::NUMERIC THEN 4
                                    WHEN dd.data->>'MC_STATUS' = '1' THEN 1
                                    ELSE 2
                                END
                            ELSE 2
                        END AS status
                    FROM oee.device_data dd
                    WHERE dd.deviceuid = m.machine_id
                    AND dd.timestamp >= NOW() - INTERVAL '15 minutes'
                    ORDER BY dd.timestamp DESC
                    LIMIT 1
                ), 
                2
            ) AS status,

            COALESCE(
                (
                    SELECT ROUND(SUM(max_prod - min_prod), 0)
                    FROM month_data md
                    WHERE md.machine_id = m.machine_id
                    AND md.year = EXTRACT(YEAR FROM CURRENT_DATE)
                    AND md.month BETWEEN EXTRACT(MONTH FROM TO_TIMESTAMP($2, 'YYYY-MM-DD HH24:MI:SS')) 
                                        AND EXTRACT(MONTH FROM TO_TIMESTAMP($3, 'YYYY-MM-DD HH24:MI:SS'))
                ),
                0
            ) AS produced_length,

            COALESCE(rt.produced_reels, 0) AS produced_reels

        FROM oee.oee_machine m
        JOIN oee.oee_machine_type mt 
        ON m.machine_type_id = mt.machine_type_id
        LEFT JOIN oee.oee_machine_parts p 
        ON m.machine_uid = p.machine_id
        LEFT JOIN reel_transitions rt
        ON m.machine_id = rt.machine_id
        WHERE m.company_id = $1
        GROUP BY 
            m.machine_uid, 
            m.machine_id, 
            m.machine_name, 
            m.machine_plant, 
            m.machine_model, 
            m.machine_customer, 
            m.machine_location, 
            m.machine_longitude, 
            m.machine_latitude, 
            mt.machine_type_name,
            m.company_id, rt.produced_reels;
    `;

    try {
        const result = await db.query(query, [company_id, start_date, end_date]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No machines found for this company' });
        }
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function getMachineName(req, res) {
    const { machine_id } = req.params;

    const query = `
        Select * from oee.oee_machine where machine_uid = $1;
    `;

    try {
        const result = await db.query(query, [machine_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No machines found' });
        }
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
} 

async function dataByDeviceId(req, res) {
    const { device_id, start_date, end_date } = req.params;

    const query = `
    WITH per_minute_stats AS (
      SELECT
        TO_CHAR(DATE_TRUNC('minute', timestamp), 'HH24:MI') AS minute,
        COUNT(*) AS data_points,
        SUM(CASE WHEN (data->>'MC_STATUS')::numeric = 1 THEN 1 ELSE 0 END) AS uptime_points,
        SUM(CASE WHEN (data->>'MC_STATUS')::numeric = 0 THEN 1 ELSE 0 END) AS downtime_points
      FROM
        oee.device_data
      WHERE 
        deviceUid = $1
        AND data::jsonb ? 'MC_STATUS'
        AND timestamp BETWEEN $2 AND $3
      GROUP BY
        DATE_TRUNC('minute', timestamp)
    ),
    availability AS (
      SELECT
        (SUM(uptime_points * 1.0 / data_points) / 
         NULLIF(SUM(uptime_points * 1.0 / data_points) + SUM(downtime_points * 1.0 / data_points), 0)) * 100 AS total_uptime_percentage
      FROM
        per_minute_stats
    ),
    production_data AS (
      SELECT 
        (data->>'LINE_SPEED')::numeric AS line_speed,
        (data->>'ACT_COLD_DIA')::numeric AS diameter,
        timestamp,
        LEAD(timestamp) OVER (ORDER BY timestamp) AS next_timestamp
      FROM 
        oee.device_data
      WHERE 
        deviceUid = $1
        AND data::jsonb ? 'LINE_SPEED'
        AND timestamp BETWEEN $2 AND $3
    ),
    calculated_data AS (
      SELECT 
        line_speed,
        diameter,
        EXTRACT(EPOCH FROM (next_timestamp - timestamp)) / 60 AS time_diff_minutes,
        timestamp
      FROM 
        production_data
      WHERE 
        next_timestamp IS NOT NULL
    ),
    actual_production_weight AS (
      SELECT 
        COALESCE(
          SUM(
            (3.14159 * ((diameter / 1000 / 2)^2) * 
            time_diff_minutes * 
            line_speed * 
            7860) / 1000
          ), 0
        ) AS actual_weight
      FROM 
        calculated_data
    ),
    per_minute_stats_for_performance AS (
      SELECT
        TO_CHAR(DATE_TRUNC('day', timestamp), 'YYYY-MM-DD') AS date,
        TO_CHAR(DATE_TRUNC('minute', timestamp), 'HH24:MI') AS minute,
        COUNT(*) AS data_points,
        SUM(CASE WHEN (data->>'MC_STATUS')::numeric = 1 THEN 1 ELSE 0 END) AS uptime_points,
        EXTRACT(EPOCH FROM MAX(timestamp) - MIN(timestamp)) / 60 AS time_diff_minutes,
        MAX((data->>'LINE_SPEED')::numeric) AS max_speed
      FROM
        oee.device_data
      WHERE 
        deviceUid = $1
        AND data::jsonb ? 'MC_STATUS'
        AND data::jsonb ? 'LINE_SPEED'
        AND timestamp BETWEEN $2 AND $3
      GROUP BY
        DATE_TRUNC('day', timestamp),
        DATE_TRUNC('minute', timestamp)
    ),
    daily_max_speed AS (
      SELECT
        date,
        MAX(max_speed) AS max_speed
      FROM
        per_minute_stats_for_performance
      GROUP BY
        date
    ),
    target_length AS (
      SELECT
        SUM(pms.uptime_points * 1.0 / pms.data_points * dms.max_speed * pms.time_diff_minutes) AS total_length
      FROM
        per_minute_stats_for_performance pms
      JOIN
        daily_max_speed dms
      ON
        pms.date = dms.date
    ),
    target_production_weight AS (
      SELECT
        COALESCE(
          SUM(
            (3.14159 * ((dia.diameter / 1000 / 2)^2) * 
            tl.total_length * 
            7860) / 1000
          ), 0
        ) AS target_weight
      FROM 
        target_length tl,
        (SELECT DISTINCT (data->>'ACT_COLD_DIA')::numeric AS diameter
         FROM oee.device_data
         WHERE deviceUid = $1
         AND data::jsonb ? 'ACT_COLD_DIA'
         AND timestamp BETWEEN $2 AND $3) dia
    )
    SELECT
      CASE
        WHEN availability.total_uptime_percentage = 0 OR (CASE WHEN target_weight = 0 THEN 0 ELSE (actual_weight / target_weight) * 100 END) = 0 THEN 0
        ELSE TO_CHAR((availability.total_uptime_percentage * (CASE WHEN target_weight = 0 THEN 0 ELSE (actual_weight / target_weight) * 100 END)) / 100, 'FM999999999.00')::numeric
      END AS "OEE",
      TO_CHAR(availability.total_uptime_percentage, 'FM999999999.00')::numeric AS "Availability",
      CASE 
        WHEN target_weight = 0 THEN 0
        ELSE TO_CHAR((actual_weight / target_weight) * 100, 'FM999999999.00')::numeric
      END AS "Performance",
      CASE 
        WHEN actual_weight = 0 THEN 100
        ELSE TO_CHAR((actual_weight / (actual_weight + 0)) * 100, 'FM999999999.00')::numeric  -- 0 used as a placeholder for rejected_production
      END AS "Quality"
    FROM
      availability,
      actual_production_weight,
      target_production_weight;
    `;

    try {
        const result = await db.query(query, [device_id, start_date, end_date]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No data found for this device within the specified time range.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching data:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    machineByCompanyId,
    getMachineName,
    dataByDeviceId    
}