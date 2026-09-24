import type { JSX as IxIconJSX } from '@siemens/ix-icons/components';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ix-icon': IxIconJSX.IntrinsicElements['ix-icon'];
    }
  }
}

export {};
