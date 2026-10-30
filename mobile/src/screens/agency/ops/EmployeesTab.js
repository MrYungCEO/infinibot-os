/**
 * Employees — web renderEmployeeDirectory: summary strip, Everyone/AI/Humans
 * filter, search, Cards/Dense layout, roster cards (Profile, Customise, Assign
 * work, capacity). Tapping opens the full employee profile sheet.
 */
import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { Button, Chip, Field, SegmentedControl, SPACE, useUIKit } from '../../../ui-kit';
import { allocationPct, employeeSummary, filterEmployees } from './agency-ops-model';
import { EmployeeCard } from './OverviewTab';
import { Empty, KpiGrid, Meta, MoreButton, Panel, Row, Tile, Avatar } from './ui';

export function EmployeesTab({ ctx }) {
  const s = ctx.ops.state;
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [layout, setLayout] = useState('cards');
  const [limit, setLimit] = useState(20);
  const { colors, type } = useUIKit();
  const sum = employeeSummary(s.employees);
  const list = filterEmployees(s.employees, { filter, search });
  return (
    <View>
      <Panel
        eyebrow="Workforce"
        title="Employee directory"
        subtitle="One accountable roster for human and AI employees."
        right={<Button title="+ Employee" size="sm" onPress={() => ctx.openDialog('employee')} accessibilityLabel="Add employee" />}
      />
      <KpiGrid
        items={[
          { label: 'Total employees', value: String(sum.total) },
          { label: 'Humans', value: String(sum.humans) },
          { label: 'AI employees', value: String(sum.ai) },
          { label: 'Blocked', value: String(sum.blocked), tone: sum.blocked ? 'danger' : 'primary' },
          { label: 'Self-completing', value: String(sum.autonomous), context: 'Autonomy level 2 or 3' },
        ]}
      />
      <SegmentedControl options={[{ key: 'all', label: 'Everyone' }, { key: 'ai', label: 'AI employees' }, { key: 'human', label: 'Humans' }]} value={filter} onChange={setFilter} style={{ marginBottom: SPACE.sm }} />
      <Field value={search} onChangeText={setSearch} placeholder="Search name, role, department or model" icon="search" style={{ marginBottom: SPACE.sm }} accessibilityLabel="Search employees" />
      <Row style={{ marginBottom: SPACE.sm }}>
        <SegmentedControl size="sm" options={[{ key: 'cards', label: 'Cards' }, { key: 'list', label: 'Dense' }]} value={layout} onChange={setLayout} style={{ flex: 1 }} />
        <Meta>{list.length} shown</Meta>
      </Row>
      {list.length ? list.slice(0, limit).map((e) => (layout === 'cards' ? <EmployeeCard key={e.id} ctx={ctx} employee={e} /> : (
        <Tile key={e.id} onPress={() => ctx.openEmployee(e.id)} accessibilityLabel={`Open ${e.name}`}>
          <Row>
            <Avatar name={e.name} ai={e.kind === 'ai'} size={30} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{e.name}</Text>
              <Meta numberOfLines={1}>{e.role || 'No role set'}</Meta>
            </View>
            <Chip size="sm" label={`${allocationPct(e)}%`} tone={allocationPct(e) > 100 ? 'danger' : 'neutral'} />
          </Row>
        </Tile>
      ))) : <Empty icon="people-outline" text={s.employees.length ? `${s.employees.length} employees are on the roster, but none match this filter or search.` : 'No employees on the roster. Add a human or AI employee to establish one.'} />}
      <MoreButton shown={Math.min(limit, list.length)} total={list.length} onPress={() => setLimit((l) => l + 20)} noun="employees" />
    </View>
  );
}
