import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { resolveMobileBrandTitle } from '@app/mobile-navigation';
import { MobileNavigation } from '@app/MobileNavigation';

test('mobile-header: resolveMobileBrandTitle returns active project name when provided', () => {
  assert.equal(resolveMobileBrandTitle('My Awesome Project', 'Pi Viewer'), 'My Awesome Project');
  assert.equal(resolveMobileBrandTitle('Frontend App', 'Fallback Title'), 'Frontend App');
});

test('mobile-header: resolveMobileBrandTitle trims whitespace from project name', () => {
  assert.equal(resolveMobileBrandTitle('  Trimmed Project  ', 'Pi Viewer'), 'Trimmed Project');
});

test('mobile-header: resolveMobileBrandTitle falls back to app title when project name is empty, whitespace, null, or undefined', () => {
  assert.equal(resolveMobileBrandTitle(undefined, 'Pi Viewer'), 'Pi Viewer');
  assert.equal(resolveMobileBrandTitle(null, 'Pi Viewer'), 'Pi Viewer');
  assert.equal(resolveMobileBrandTitle('', 'Pi Viewer'), 'Pi Viewer');
  assert.equal(resolveMobileBrandTitle('   ', 'Pi Viewer'), 'Pi Viewer');
});

test('mobile-header: drawer title group displays Pi Viewer branding and version, NOT navigation or project name', () => {
  const html = renderToStaticMarkup(
    React.createElement(MobileNavigation, {
      isOpen: true,
      isMobile: true,
      activeProjectName: 'Secret Project',
      onClose: () => {},
      locale: 'en',
    })
  );

  // Must contain mobile-nav-drawer-title-group
  assert.ok(html.includes('mobile-nav-drawer-title-group'), 'Header title group must be present');

  // Must contain Pi Viewer and version
  assert.ok(html.includes('Pi Viewer'), 'Drawer title group must include Pi Viewer');
  assert.ok(html.includes('v0.2.0'), 'Drawer title group must include app version');

  // Must NOT include active project name inside drawer title group
  const titleGroupMatch = html.match(/<div class="mobile-nav-drawer-title-group">([\s\S]*?)<\/div>/);
  assert.ok(titleGroupMatch, 'Must match mobile-nav-drawer-title-group');
  const titleGroupContent = titleGroupMatch[1];

  assert.ok(
    !titleGroupContent.includes('Secret Project'),
    'Drawer title group must NOT contain active project name'
  );
  assert.ok(
    !titleGroupContent.includes('Navigation') && !titleGroupContent.includes('Navegación'),
    'Drawer title group must NOT contain Navigation label'
  );
});

test('mobile-header: drawer title group displays Pi Viewer branding and version in Spanish without Navigation label', () => {
  const htmlEs = renderToStaticMarkup(
    React.createElement(MobileNavigation, {
      isOpen: true,
      isMobile: true,
      activeProjectName: 'Proyecto X',
      onClose: () => {},
      locale: 'es',
    })
  );

  const titleGroupMatch = htmlEs.match(/<div class="mobile-nav-drawer-title-group">([\s\S]*?)<\/div>/);
  assert.ok(titleGroupMatch, 'Must match mobile-nav-drawer-title-group in Spanish');
  const titleGroupContent = titleGroupMatch[1];

  assert.ok(titleGroupContent.includes('Pi Viewer'), 'Must contain Pi Viewer');
  assert.ok(titleGroupContent.includes('v0.2.0'), 'Must contain version v0.2.0');
  assert.ok(
    !titleGroupContent.includes('Proyecto X'),
    'Drawer title group must NOT contain active project name in Spanish'
  );
  assert.ok(
    !titleGroupContent.includes('Navegación'),
    'Drawer title group must NOT contain Navegación label'
  );
});

test('mobile-header: header brand structure exposes both desktop title and mobile project title', () => {
  // Simulate header brand structure as rendered by App
  const activeProjectName = 'Alpha Project';
  const appTitle = 'Pi Viewer';
  const resolvedMobileTitle = resolveMobileBrandTitle(activeProjectName, appTitle);

  const headerMarkup = renderToStaticMarkup(
    React.createElement(
      'div',
      { className: 'brand-text' },
      React.createElement(
        'h1',
        { className: 'brand-title' },
        React.createElement('span', { className: 'brand-title-desktop' }, appTitle),
        React.createElement(
          'span',
          { className: 'brand-title-mobile', title: resolvedMobileTitle },
          resolvedMobileTitle
        )
      ),
      React.createElement('span', { className: 'brand-version' }, 'v0.2.0')
    )
  );

  assert.ok(headerMarkup.includes('brand-title-desktop'), 'Desktop title span must exist');
  assert.ok(headerMarkup.includes('>Pi Viewer</span>'), 'Desktop title must display Pi Viewer');
  assert.ok(headerMarkup.includes('brand-title-mobile'), 'Mobile title span must exist');
  assert.ok(headerMarkup.includes('>Alpha Project</span>'), 'Mobile title must display active project name');
});

test('mobile-header: header brand falls back cleanly to app title when activeProject is undefined', () => {
  const activeProjectName = undefined;
  const appTitle = 'Pi Viewer';
  const resolvedMobileTitle = resolveMobileBrandTitle(activeProjectName, appTitle);

  const headerMarkup = renderToStaticMarkup(
    React.createElement(
      'div',
      { className: 'brand-text' },
      React.createElement(
        'h1',
        { className: 'brand-title' },
        React.createElement('span', { className: 'brand-title-desktop' }, appTitle),
        React.createElement(
          'span',
          { className: 'brand-title-mobile', title: resolvedMobileTitle },
          resolvedMobileTitle
        )
      ),
      React.createElement('span', { className: 'brand-version' }, 'v0.2.0')
    )
  );

  assert.equal(resolvedMobileTitle, 'Pi Viewer');
  assert.ok(headerMarkup.includes('>Pi Viewer</span>'), 'Mobile title falls back to Pi Viewer');
});
